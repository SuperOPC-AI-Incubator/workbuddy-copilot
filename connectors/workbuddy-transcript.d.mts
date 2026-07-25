export type WorkbuddyTurn = {
  userMessageId: string;
  promptText: string;
  replyText: string;
  userTimestamp: number | null;
};

export type ParsedTranscript = {
  turns: WorkbuddyTurn[];
  droppedLeadingPartial: boolean;
  droppedTrailingPartial: boolean;
  sessionTitle: string | null;
  sessionId: string | null;
  cwd: string | null;
};

export type WorkbuddyTurnEvent = {
  event_id: string;
  source: "connector";
  source_session_key: string;
  session_title: string;
  prompt: string;
  reply: string;
  client_created_at?: string;
};

export const PROMPT_MAX_LENGTH: number;
export const REPLY_MAX_LENGTH: number;
export const SESSION_TITLE_MAX_LENGTH: number;
export const SOURCE_SESSION_KEY_MAX_LENGTH: number;
export const DEFAULT_SESSION_TITLE: string;
export const TITLE_HEAD_BYTES: number;
export const TITLE_TAIL_BYTES: number;

export function findSessionTitle(input: string | Uint8Array): string | null;

export function readSessionTitle(fs: unknown, path: string): Promise<string | null>;

export function parseTranscriptTail(
  input: string | Uint8Array,
  options?: Record<string, never>,
): ParsedTranscript;

export function extractUserQuery(text: string): string;

export function resolveSessionTitle(
  sessionTitle: string | null | undefined,
  cwd: string | null | undefined,
): string;

export function buildTurnEvent(input: {
  turn: WorkbuddyTurn;
  sourceSessionKey: string;
  sessionTitle: string | null | undefined;
  cwd: string | null | undefined;
  eventId: string;
}): WorkbuddyTurnEvent | null;
