import { z } from "zod";

export const WORKBUDDY_CONTRACT_VERSION = 1 as const;
export const WORKBUDDY_SOURCE_SESSION_KEY_MAX_LENGTH = 255;
export const WORKBUDDY_PROMPT_MAX_LENGTH = 4_000;
export const WORKBUDDY_REPLY_MAX_LENGTH = 8_000;
export const WORKBUDDY_DIAGNOSIS_MAX_LENGTH = 2_000;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

export const ReliableWorkbuddyTurnSchema = z
  .object({
    event_id: z.string().uuid(),
    source: z.enum(["mcp", "skill", "connector"]),
    source_session_key: boundedText(WORKBUDDY_SOURCE_SESSION_KEY_MAX_LENGTH),
    session_title: boundedText(120).default("WorkBuddy 会话"),
    prompt: boundedText(WORKBUDDY_PROMPT_MAX_LENGTH),
    reply: boundedText(WORKBUDDY_REPLY_MAX_LENGTH),
    diagnosis: z
      .object({
        text: boundedText(WORKBUDDY_DIAGNOSIS_MAX_LENGTH),
        severity: z.enum(["ok", "warn", "error"]),
      })
      .strict()
      .optional(),
    client_created_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export type ReliableWorkbuddyTurn = z.output<typeof ReliableWorkbuddyTurnSchema>;

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function canonicalizeJson(value: unknown): CanonicalJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("NON_FINITE_JSON_NUMBER");
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entryValue]) => [key, canonicalizeJson(entryValue)]),
    );
  }

  throw new TypeError("UNSUPPORTED_JSON_VALUE");
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

/**
 * The payload hash intentionally includes every client-controlled content and
 * session-routing field, plus a contract version. It excludes event_id (the
 * idempotency key) and student_id (always resolved by the trusted server).
 */
export function canonicalWorkbuddyPayload(turn: ReliableWorkbuddyTurn) {
  return {
    contract_version: WORKBUDDY_CONTRACT_VERSION,
    source: turn.source,
    source_session_key: turn.source_session_key,
    session_title: turn.session_title,
    prompt: turn.prompt,
    reply: turn.reply,
    diagnosis: turn.diagnosis ?? null,
    client_created_at: turn.client_created_at ?? null,
  };
}

export class WorkbuddyEventConflictError extends Error {
  readonly code = "EVENT_ID_CONFLICT";

  constructor() {
    super("EVENT_ID_CONFLICT");
    this.name = "WorkbuddyEventConflictError";
  }
}

export class InvalidWorkbuddyCredentialError extends Error {
  readonly code = "INVALID_WORKBUDDY_CREDENTIAL";

  constructor() {
    super("INVALID_WORKBUDDY_CREDENTIAL");
    this.name = "InvalidWorkbuddyCredentialError";
  }
}

export class MissingWorkbuddyCredentialError extends Error {
  readonly code = "MISSING_WORKBUDDY_CREDENTIAL";

  constructor() {
    super("MISSING_WORKBUDDY_CREDENTIAL");
    this.name = "MissingWorkbuddyCredentialError";
  }
}

export class RevokedWorkbuddyCredentialError extends Error {
  readonly code = "REVOKED_WORKBUDDY_CREDENTIAL";

  constructor() {
    super("REVOKED_WORKBUDDY_CREDENTIAL");
    this.name = "RevokedWorkbuddyCredentialError";
  }
}
