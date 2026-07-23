import { z } from "zod";

import type { Json } from "@/integrations/supabase/types";
import { isMentorMessageWithinLimit } from "@/lib/workbuddy/mentor-message-contract";

const MentorMessageInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    text: z
      .string()
      .transform((value) => value.trim())
      .refine((value) => value.length > 0 && isMentorMessageWithinLimit(value)),
    severity: z.enum(["ok", "warn", "error"]).nullable().optional(),
  })
  .strict();

const MentorMessageRpcResultSchema = z
  .object({
    message_id: z.string().uuid(),
    student_id: z.string().uuid(),
    session_id: z.string().uuid(),
    delivery_state: z.literal("pending"),
  })
  .strict();

export type MentorMessageGatewayError = {
  code?: string;
  message?: string;
};

export type MentorMessageRpcArgs = {
  _author_user_id: string;
  _session_id: string;
  _text: string;
  _severity: "ok" | "warn" | "error" | null;
};

export interface MentorMessageGateway {
  create(args: MentorMessageRpcArgs): Promise<{
    data: unknown;
    error: MentorMessageGatewayError | null;
  }>;
}

export class MentorMessageCreateError extends Error {
  readonly code:
    | "MENTOR_MESSAGE_INPUT_INVALID"
    | "MENTOR_MESSAGE_CREATE_FAILED"
    | "MENTOR_MESSAGE_RESULT_INVALID";

  constructor(
    code:
      | "MENTOR_MESSAGE_INPUT_INVALID"
      | "MENTOR_MESSAGE_CREATE_FAILED"
      | "MENTOR_MESSAGE_RESULT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "MentorMessageCreateError";
    this.code = code;
  }
}

export async function createMentorMessage(
  request: {
    actorUserId: string;
    input: unknown;
  },
  dependencies: { gateway: MentorMessageGateway },
): Promise<{ messageId: string; sessionId: string; deliveryState: "pending" }> {
  const actor = z.string().uuid().safeParse(request.actorUserId);
  const input = MentorMessageInputSchema.safeParse(request.input);
  if (!actor.success || !input.success) {
    throw new MentorMessageCreateError(
      "MENTOR_MESSAGE_INPUT_INVALID",
      "导师消息内容无效，请检查后重试。",
    );
  }

  const { data, error } = await dependencies.gateway.create({
    _author_user_id: actor.data,
    _session_id: input.data.sessionId,
    _text: input.data.text,
    _severity: input.data.severity ?? null,
  });
  if (error) {
    throw new MentorMessageCreateError(
      "MENTOR_MESSAGE_CREATE_FAILED",
      "导师消息发送失败，请稍后重试。",
    );
  }

  const result = MentorMessageRpcResultSchema.safeParse(data);
  if (!result.success || result.data.session_id !== input.data.sessionId) {
    throw new MentorMessageCreateError(
      "MENTOR_MESSAGE_RESULT_INVALID",
      "导师消息发送结果无效，请刷新后确认。",
    );
  }

  return {
    messageId: result.data.message_id,
    sessionId: result.data.session_id,
    deliveryState: result.data.delivery_state,
  };
}

type SupabaseMentorMessageRpcClient = {
  rpc(
    name: "create_mentor_message",
    args: MentorMessageRpcArgs,
  ): PromiseLike<{
    data: Json | null;
    error: { code?: string; message: string } | null;
  }>;
};

export function createSupabaseMentorMessageGateway(
  client: SupabaseMentorMessageRpcClient,
): MentorMessageGateway {
  return {
    async create(args) {
      const { data, error } = await client.rpc("create_mentor_message", args);
      return {
        data,
        error: error ? { code: error.code, message: error.message } : null,
      };
    },
  };
}

export async function createMentorMessageOnServer(actorUserId: string, input: unknown) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return createMentorMessage(
    { actorUserId, input },
    { gateway: createSupabaseMentorMessageGateway(supabaseAdmin) },
  );
}
