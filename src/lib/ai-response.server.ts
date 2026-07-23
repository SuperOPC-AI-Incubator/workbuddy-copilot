import { z } from "zod";

import type { Json } from "@/integrations/supabase/types";

const AIResponseInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    reply: z.string().trim().min(1).max(8_000),
    diagnosis: z.string().trim().min(1).max(8_000).nullable(),
    severity: z.enum(["ok", "warn", "error"]).nullable(),
    tag: z.string().trim().max(60).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.diagnosis === null) !== (value.severity === null)) {
      context.addIssue({
        code: "custom",
        message: "diagnosis_and_severity_must_be_paired",
      });
    }
  });

const AIResponseRpcResultSchema = z
  .object({
    session_id: z.string().uuid(),
    reply_item_id: z.string().uuid(),
    diagnosis_item_id: z.string().uuid().nullable(),
  })
  .strict();

export type AIResponseRpcArgs = {
  _actor_user_id: string;
  _session_id: string;
  _reply: string;
  _diagnosis_text: string | null;
  _diagnosis_severity: "ok" | "warn" | "error" | null;
  _tag: string | null;
};

export type AIResponseGatewayError = {
  code?: string;
  message?: string;
};

export interface AIResponseGateway {
  create(args: AIResponseRpcArgs): Promise<{
    data: unknown;
    error: AIResponseGatewayError | null;
  }>;
}

export class AIResponsePersistError extends Error {
  readonly code:
    | "AI_RESPONSE_INPUT_INVALID"
    | "AI_RESPONSE_PERSIST_FAILED"
    | "AI_RESPONSE_RESULT_INVALID";

  constructor(
    code: "AI_RESPONSE_INPUT_INVALID" | "AI_RESPONSE_PERSIST_FAILED" | "AI_RESPONSE_RESULT_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "AIResponsePersistError";
    this.code = code;
  }
}

export async function persistAIResponse(
  request: { actorUserId: string; input: unknown },
  dependencies: { gateway: AIResponseGateway },
): Promise<{
  sessionId: string;
  replyItemId: string;
  diagnosisItemId: string | null;
}> {
  const actor = z.string().uuid().safeParse(request.actorUserId);
  const input = AIResponseInputSchema.safeParse(request.input);
  if (!actor.success || !input.success) {
    throw new AIResponsePersistError("AI_RESPONSE_INPUT_INVALID", "AI 回复内容无效，请稍后重试。");
  }

  const { data, error } = await dependencies.gateway.create({
    _actor_user_id: actor.data,
    _session_id: input.data.sessionId,
    _reply: input.data.reply,
    _diagnosis_text: input.data.diagnosis,
    _diagnosis_severity: input.data.severity,
    _tag: input.data.tag || null,
  });
  if (error) {
    throw new AIResponsePersistError("AI_RESPONSE_PERSIST_FAILED", "AI 回复保存失败，请稍后重试。");
  }

  const result = AIResponseRpcResultSchema.safeParse(data);
  if (
    !result.success ||
    result.data.session_id !== input.data.sessionId ||
    (input.data.diagnosis === null) !== (result.data.diagnosis_item_id === null)
  ) {
    throw new AIResponsePersistError(
      "AI_RESPONSE_RESULT_INVALID",
      "AI 回复保存结果无效，请稍后重试。",
    );
  }

  return {
    sessionId: result.data.session_id,
    replyItemId: result.data.reply_item_id,
    diagnosisItemId: result.data.diagnosis_item_id,
  };
}

type SupabaseAIResponseRpcClient = {
  rpc(
    name: "create_ai_response",
    args: AIResponseRpcArgs,
  ): PromiseLike<{
    data: Json | null;
    error: { code?: string; message: string } | null;
  }>;
};

export function createSupabaseAIResponseGateway(
  client: SupabaseAIResponseRpcClient,
): AIResponseGateway {
  return {
    async create(args) {
      const { data, error } = await client.rpc("create_ai_response", args);
      return {
        data,
        error: error ? { code: error.code, message: error.message } : null,
      };
    },
  };
}

export async function persistAIResponseOnServer(actorUserId: string, input: unknown) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return persistAIResponse(
    { actorUserId, input },
    { gateway: createSupabaseAIResponseGateway(supabaseAdmin) },
  );
}
