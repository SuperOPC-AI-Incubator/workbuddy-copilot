import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  ReliableWorkbuddyTurnSchema,
  WorkbuddyEventConflictError,
  canonicalWorkbuddyPayload,
  stableJsonStringify,
  type ReliableWorkbuddyTurn,
} from "./contracts";

export { WorkbuddyEventConflictError } from "./contracts";

export type WorkbuddyIngestRpcArgs =
  Database["public"]["Functions"]["ingest_workbuddy_turn"]["Args"];

export type WorkbuddyRpcError = {
  code?: string;
  message?: string;
};

export interface IngestWorkbuddyTurnGateway {
  ingestWorkbuddyTurn(args: WorkbuddyIngestRpcArgs): Promise<{
    data: unknown;
    error: WorkbuddyRpcError | null;
  }>;
}

export type WorkbuddyIngestResult = {
  event_id: string;
  student_id: string;
  session_id: string;
  prompt_item_id: string;
  reply_item_id: string;
  diagnosis_item_id: string | null;
  duplicate: boolean;
};

const WorkbuddyIngestResultSchema = z
  .object({
    event_id: z.string().uuid(),
    student_id: z.string().uuid(),
    session_id: z.string().uuid(),
    prompt_item_id: z.string().uuid(),
    reply_item_id: z.string().uuid(),
    diagnosis_item_id: z.string().uuid().nullable(),
    duplicate: z.boolean(),
  })
  .strict();

export class WorkbuddyIngestGatewayError extends Error {
  readonly code = "WORKBUDDY_INGEST_FAILED";

  constructor() {
    super("WORKBUDDY_INGEST_FAILED");
    this.name = "WorkbuddyIngestGatewayError";
  }
}

export class WorkbuddyIngestResultError extends Error {
  readonly code = "WORKBUDDY_INGEST_RESULT_INVALID";

  constructor(message = "WORKBUDDY_INGEST_RESULT_INVALID") {
    super(message);
    this.name = "WorkbuddyIngestResultError";
  }
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function ingestWorkbuddyTurn(
  input: {
    studentId: string;
    turn: ReliableWorkbuddyTurn;
  },
  dependencies: {
    gateway: IngestWorkbuddyTurnGateway;
    sha256?: (value: string) => string;
  },
): Promise<WorkbuddyIngestResult> {
  const turn = ReliableWorkbuddyTurnSchema.parse(input.turn);
  const payload = stableJsonStringify(canonicalWorkbuddyPayload(turn));
  const payloadSha256 = (dependencies.sha256 ?? sha256Hex)(payload);

  const { data, error } = await dependencies.gateway.ingestWorkbuddyTurn({
    _event_id: turn.event_id,
    _student_id: input.studentId,
    _source: turn.source,
    _source_session_key: turn.source_session_key,
    _session_title: turn.session_title,
    _payload_sha256: payloadSha256,
    _prompt: turn.prompt,
    _reply: turn.reply,
    _diagnosis_text: turn.diagnosis?.text ?? null,
    _diagnosis_severity: turn.diagnosis?.severity ?? null,
    _client_created_at: turn.client_created_at ?? null,
  });

  if (error?.code === "P4090" || error?.message === "workbuddy_event_conflict") {
    throw new WorkbuddyEventConflictError();
  }
  if (error) throw new WorkbuddyIngestGatewayError();

  const parsed = WorkbuddyIngestResultSchema.safeParse(data);
  if (!parsed.success) throw new WorkbuddyIngestResultError();
  if (parsed.data.student_id !== input.studentId || parsed.data.event_id !== turn.event_id) {
    throw new WorkbuddyIngestResultError("WORKBUDDY_RESULT_OWNERSHIP_MISMATCH");
  }

  return parsed.data;
}

type SupabaseIngestRpcClient = {
  rpc(
    name: "ingest_workbuddy_turn",
    args: WorkbuddyIngestRpcArgs,
  ): PromiseLike<{
    data: Json | null;
    error: { code?: string; message: string } | null;
  }>;
};

export function createSupabaseWorkbuddyIngestGateway(
  client: SupabaseIngestRpcClient,
): IngestWorkbuddyTurnGateway {
  return {
    async ingestWorkbuddyTurn(args) {
      const { data, error } = await client.rpc("ingest_workbuddy_turn", args);
      return {
        data,
        error: error ? { code: error.code, message: error.message } : null,
      };
    },
  };
}
