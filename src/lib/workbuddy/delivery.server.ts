import { z } from "zod";

import type { Json } from "@/integrations/supabase/types";
import { isMentorMessageWithinLimit } from "./mentor-message-contract";

const UuidSchema = z.string().uuid();
const TimestampSchema = z.iso.datetime({ offset: true });
const CursorSchema = z
  .object({
    created_at: TimestampSchema,
    id: UuidSchema,
  })
  .strict();

const DeliveryRpcMessageSchema = z
  .object({
    id: UuidSchema,
    student_id: UuidSchema,
    session_id: UuidSchema,
    text: z.string().refine(isMentorMessageWithinLimit),
    author_username: z.string().trim().min(1).max(128),
    created_at: TimestampSchema,
    first_fetched_at: TimestampSchema,
    last_fetched_at: TimestampSchema,
    fetch_count: z.number().int().positive(),
    acknowledged_at: z.null(),
  })
  .strict();

const DeliveryFetchResultSchema = z
  .object({
    messages: z.array(DeliveryRpcMessageSchema).max(100),
  })
  .strict();

const AcknowledgedMessageSchema = z
  .object({
    id: UuidSchema,
    acknowledged_at: TimestampSchema,
  })
  .strict();

const DeliveryAckResultSchema = z
  .object({
    acknowledged: z.array(AcknowledgedMessageSchema).min(1).max(100),
  })
  .strict();

export type DeliveryRpcMessage = z.infer<typeof DeliveryRpcMessageSchema>;

export type WorkbuddyMentorMessage = Omit<DeliveryRpcMessage, "student_id" | "acknowledged_at">;

export type WorkbuddyMentorMessagePage = {
  messages: WorkbuddyMentorMessage[];
  next_cursor: string | null;
};

export type DeliveryFetchRpcArgs = {
  _student_id: string;
  _session_id: string | null;
  _limit: number;
  _cursor_created_at: string | null;
  _cursor_id: string | null;
};

export type DeliveryAckRpcArgs = {
  _student_id: string;
  _message_ids: string[];
};

type RpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

export interface DeliveryGateway {
  fetchPending(args: DeliveryFetchRpcArgs): Promise<RpcResult>;
  acknowledge(args: DeliveryAckRpcArgs): Promise<RpcResult>;
}

export class DeliveryGatewayError extends Error {
  readonly code = "WORKBUDDY_DELIVERY_GATEWAY_FAILED";

  constructor() {
    super("WORKBUDDY_DELIVERY_GATEWAY_FAILED");
    this.name = "DeliveryGatewayError";
  }
}

export class DeliveryOwnershipError extends Error {
  readonly code = "INVALID_MESSAGE_IDS";

  constructor() {
    super("INVALID_MESSAGE_IDS");
    this.name = "DeliveryOwnershipError";
  }
}

export class DeliverySessionError extends Error {
  readonly code = "INVALID_SESSION";

  constructor() {
    super("INVALID_SESSION");
    this.name = "DeliverySessionError";
  }
}

export class InvalidDeliveryCursorError extends Error {
  readonly code = "INVALID_CURSOR";

  constructor() {
    super("INVALID_CURSOR");
    this.name = "InvalidDeliveryCursorError";
  }
}

function compareMessageIdentity(
  left: Pick<DeliveryRpcMessage, "created_at" | "id">,
  right: Pick<DeliveryRpcMessage, "created_at" | "id">,
): number {
  if (left.created_at !== right.created_at) {
    return left.created_at < right.created_at ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function encodeDeliveryCursor(cursor: z.infer<typeof CursorSchema>): string {
  const parsed = CursorSchema.parse(cursor);
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
}

export function decodeDeliveryCursor(value: string): z.infer<typeof CursorSchema> {
  if (value.length === 0 || value.length > 2_000 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidDeliveryCursorError();
  }

  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed = CursorSchema.parse(JSON.parse(decoded));
    if (encodeDeliveryCursor(parsed) !== value) throw new InvalidDeliveryCursorError();
    return parsed;
  } catch (error) {
    if (error instanceof InvalidDeliveryCursorError) throw error;
    throw new InvalidDeliveryCursorError();
  }
}

export async function fetchPendingMentorMessages(
  input: {
    studentId: string;
    sessionId?: string;
    limit?: number;
    cursor?: string;
  },
  dependencies: { gateway: DeliveryGateway },
): Promise<WorkbuddyMentorMessagePage> {
  const studentId = UuidSchema.parse(input.studentId);
  const sessionId = input.sessionId === undefined ? null : UuidSchema.parse(input.sessionId);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(input.limit ?? 50);
  const cursor = input.cursor === undefined ? null : decodeDeliveryCursor(input.cursor);

  const { data, error } = await dependencies.gateway.fetchPending({
    _student_id: studentId,
    _session_id: sessionId,
    _limit: limit,
    _cursor_created_at: cursor?.created_at ?? null,
    _cursor_id: cursor?.id ?? null,
  });

  if (error) {
    if (error.code === "P4041" || error.message === "workbuddy_session_not_owned") {
      throw new DeliverySessionError();
    }
    throw new DeliveryGatewayError();
  }

  const parsed = DeliveryFetchResultSchema.safeParse(data);
  if (!parsed.success) throw new DeliveryGatewayError();

  for (let index = 0; index < parsed.data.messages.length; index += 1) {
    const current = parsed.data.messages[index]!;
    if (
      current.student_id !== studentId ||
      (sessionId !== null && current.session_id !== sessionId) ||
      (index > 0 && compareMessageIdentity(parsed.data.messages[index - 1]!, current) >= 0)
    ) {
      throw new DeliveryGatewayError();
    }
  }

  const messages = parsed.data.messages.map(
    ({ student_id: _studentId, acknowledged_at: _acknowledgedAt, ...safe }) => safe,
  );
  const last = messages.at(-1);

  return {
    messages,
    next_cursor:
      messages.length === limit && last
        ? encodeDeliveryCursor({ created_at: last.created_at, id: last.id })
        : null,
  };
}

export async function acknowledgeMentorMessages(
  input: { studentId: string; messageIds: string[] },
  dependencies: { gateway: DeliveryGateway },
): Promise<z.infer<typeof DeliveryAckResultSchema>> {
  const studentId = UuidSchema.parse(input.studentId);
  const parsedIds = z.array(UuidSchema).min(1).max(100).safeParse(input.messageIds);
  if (!parsedIds.success || new Set(parsedIds.data).size !== parsedIds.data.length) {
    throw new DeliveryOwnershipError();
  }

  const { data, error } = await dependencies.gateway.acknowledge({
    _student_id: studentId,
    _message_ids: parsedIds.data,
  });
  if (error) {
    if (error.code === "P4040" || error.message === "workbuddy_delivery_not_owned") {
      throw new DeliveryOwnershipError();
    }
    throw new DeliveryGatewayError();
  }

  const parsed = DeliveryAckResultSchema.safeParse(data);
  if (!parsed.success) throw new DeliveryGatewayError();
  const expected = new Set(parsedIds.data);
  if (
    parsed.data.acknowledged.length !== expected.size ||
    parsed.data.acknowledged.some(({ id }) => !expected.has(id)) ||
    new Set(parsed.data.acknowledged.map(({ id }) => id)).size !== expected.size
  ) {
    throw new DeliveryGatewayError();
  }

  return parsed.data;
}

type SupabaseDeliveryRpcClient = {
  rpc(
    name: "fetch_workbuddy_mentor_messages" | "ack_workbuddy_mentor_messages",
    args: DeliveryFetchRpcArgs | DeliveryAckRpcArgs,
  ): PromiseLike<{
    data: Json | null;
    error: { code?: string; message: string } | null;
  }>;
};

export function createSupabaseDeliveryGateway(client: SupabaseDeliveryRpcClient): DeliveryGateway {
  return {
    async fetchPending(args) {
      const { data, error } = await client.rpc("fetch_workbuddy_mentor_messages", args);
      return { data, error };
    },
    async acknowledge(args) {
      const { data, error } = await client.rpc("ack_workbuddy_mentor_messages", args);
      return { data, error };
    },
  };
}
