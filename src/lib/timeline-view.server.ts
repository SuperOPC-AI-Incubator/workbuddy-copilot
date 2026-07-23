import { z } from "zod";

import type { Json } from "@/integrations/supabase/types";

const TimelineItemSchema = z
  .object({
    id: z.string().uuid(),
    session_id: z.string().uuid(),
    kind: z.enum(["prompt", "reply", "diagnosis", "mentor"]),
    text: z.string(),
    severity: z.enum(["ok", "warn", "error"]).nullable(),
    tag: z.string().nullable(),
    author_username: z.string().nullable(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();

const DeliverySchema = z
  .object({
    message_id: z.string().uuid(),
    session_id: z.string().uuid(),
    first_fetched_at: z.string().datetime({ offset: true }).nullable(),
    last_fetched_at: z.string().datetime({ offset: true }).nullable(),
    fetch_count: z.number().int().nonnegative(),
    acknowledged_at: z.string().datetime({ offset: true }).nullable(),
    web_seen_at: z.string().datetime({ offset: true }).nullable(),
    failure_count: z.number().int().nonnegative(),
    last_error_code: z.string().nullable(),
  })
  .strict();

const SnapshotSchema = z
  .object({
    session_id: z.string().uuid(),
    items: z.array(
      z
        .object({
          timeline: TimelineItemSchema,
          delivery: DeliverySchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();

type TimelineSnapshotRpcArgs = {
  _actor_user_id: string;
  _session_id: string;
};

export interface TimelineSnapshotGateway {
  snapshot(args: TimelineSnapshotRpcArgs): Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

export class TimelineViewError extends Error {
  readonly code = "TIMELINE_VIEW_FAILED";

  constructor() {
    super("时间线加载失败，请稍后重试。");
    this.name = "TimelineViewError";
  }
}

export async function loadTimelineDeliveryView(
  request: { actorUserId: string; sessionId: string },
  dependencies: { gateway: TimelineSnapshotGateway },
) {
  const actor = z.string().uuid().safeParse(request.actorUserId);
  const session = z.string().uuid().safeParse(request.sessionId);
  if (!actor.success || !session.success) throw new TimelineViewError();

  const { data, error } = await dependencies.gateway.snapshot({
    _actor_user_id: actor.data,
    _session_id: session.data,
  });
  if (error) throw new TimelineViewError();
  const snapshot = SnapshotSchema.safeParse(data);
  if (!snapshot.success || snapshot.data.session_id !== session.data) {
    throw new TimelineViewError();
  }

  for (const item of snapshot.data.items) {
    if (item.timeline.session_id !== session.data) throw new TimelineViewError();
    if (
      item.delivery &&
      (item.timeline.kind !== "mentor" ||
        item.delivery.message_id !== item.timeline.id ||
        item.delivery.session_id !== session.data)
    ) {
      throw new TimelineViewError();
    }
  }

  return {
    timeline: snapshot.data.items.map((item) => item.timeline),
    deliveries: snapshot.data.items.flatMap((item) => (item.delivery ? [item.delivery] : [])),
  };
}

type SupabaseTimelineSnapshotClient = {
  rpc(
    name: "get_timeline_delivery_snapshot",
    args: TimelineSnapshotRpcArgs,
  ): PromiseLike<{
    data: Json | null;
    error: { code?: string; message: string } | null;
  }>;
};

export function createSupabaseTimelineSnapshotGateway(
  client: SupabaseTimelineSnapshotClient,
): TimelineSnapshotGateway {
  return {
    async snapshot(args) {
      const { data, error } = await client.rpc("get_timeline_delivery_snapshot", args);
      return {
        data,
        error: error ? { code: error.code, message: error.message } : null,
      };
    },
  };
}

export async function loadTimelineDeliveryViewOnServer(actorUserId: string, sessionId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return loadTimelineDeliveryView(
    { actorUserId, sessionId },
    { gateway: createSupabaseTimelineSnapshotGateway(supabaseAdmin) },
  );
}
