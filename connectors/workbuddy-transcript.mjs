/**
 * Parse WorkBuddy transcript JSONL into user/assistant turns.
 *
 * Real-shape facts this parser is written against (measured on
 * ~/.workbuddy/projects/<project>/<session_id>.jsonl, 90 sessions):
 *   - line types seen: message, reasoning, function_call, function_call_result,
 *     file-history-snapshot, ai-title, custom-title
 *   - `message` rows carry: id, timestamp, type, role, content, sessionId, cwd
 *   - roles seen on `message` rows: user, assistant
 *   - content is an array of items; item types seen: input_text (user),
 *     output_text (assistant), image_blob_ref (user attachments)
 *   - assistant `message` rows with `content: []` are common (89/959) → no text
 *   - user text is wrapped in <system-reminder>… + <user_query>…</user_query>
 *
 * PII red line: only text items of user/assistant messages are read. Tool call
 * arguments and tool results (function_call / function_call_result rows, and
 * tool_use / tool_result / image_blob_ref content items) contain file contents,
 * absolute paths and secrets — they are never extracted, not even as placeholders.
 */

import { redactCredentialsForContract, truncateForContract } from "./workbuddy-event-id.mjs";
import { StringDecoder } from "node:string_decoder";

/** Content item types that hold plain conversation text. Strict whitelist. */
const TEXT_ITEM_TYPES = new Set(["text", "input_text", "output_text"]);

const USER_QUERY_PATTERN = /<user_query>([\s\S]*?)<\/user_query>/g;

/**
 * WorkBuddy injects <system-reminder> blocks into user messages: workspace info,
 * the contents of SOUL.md / IDENTITY.md / USER.md, and automatic "please continue"
 * nudges after a network error. None of it was typed by the operator, so it is
 * stripped before falling back to the raw message text. Measured on the local
 * corpus: 8 user rows are nothing but an error-recovery reminder.
 */
const SYSTEM_REMINDER_PATTERN = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/g;

const DEFAULT_SESSION_TITLE = "WorkBuddy 会话";

/** Server contract limits (src/lib/workbuddy/contracts.ts). */
export const PROMPT_MAX_LENGTH = 4_000;
export const REPLY_MAX_LENGTH = 8_000;
export const SESSION_TITLE_MAX_LENGTH = 120;
export const SOURCE_SESSION_KEY_MAX_LENGTH = 255;

/**
 * Bounds of the canonical "title view" of a transcript.
 *
 * `ai-title` is written right after the first turn, so on a long session it sits
 * far outside the tail the Stop hook reads. If the hook and `import` resolved the
 * title from different windows they would build different payloads for the same
 * event_id, and the server's 409 handling quarantines the loser — silent data loss.
 * Both paths therefore use the same sequential, bounded-memory title reader.
 * The first complete title wins permanently: choosing a later rename would
 * change an already-derived event's payload and trigger a 409.
 */
/** Fixed-size blocks for the sequential first-title scan. */
export const TITLE_HEAD_BYTES = 64 * 1_024;
/** Maximum incomplete JSONL record retained while finding the first title. */
export const TITLE_TAIL_BYTES = 256 * 1_024;

/** Bounded head scan used to find the first transcript message's cwd. */
export const CWD_HEAD_CHUNK_BYTES = 64 * 1_024;
export const CWD_HEAD_MAX_BYTES = 1 * 1_024 * 1_024;

function decodeInput(input) {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) return input.toString("utf8");
  if (input instanceof Uint8Array) return new TextDecoder("utf-8").decode(input);
  return String(input);
}

/**
 * Extract the operator's actual question.
 *
 * WorkBuddy prepends a large <system-reminder> block (identity files, workspace
 * info, reminders) to every user message and wraps the real input in
 * <user_query>. Compacted sessions replay earlier turns, so a single user row can
 * hold several <user_query> blocks — the LAST one is the current prompt (measured:
 * 3 of 537 user rows in the local corpus carry more than one).
 */
export function extractUserQuery(text) {
  const raw = typeof text === "string" ? text : "";
  let last = null;
  USER_QUERY_PATTERN.lastIndex = 0;
  for (const match of raw.matchAll(USER_QUERY_PATTERN)) last = match[1];
  if (last !== null) return last.trim();
  SYSTEM_REMINDER_PATTERN.lastIndex = 0;
  return raw.replace(SYSTEM_REMINDER_PATTERN, "").trim();
}

function extractMessageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (!TEXT_ITEM_TYPES.has(item.type)) continue;
    const text = typeof item.text === "string" ? item.text : "";
    if (text.trim()) parts.push(text);
  }
  return parts.join("\n").trim();
}

/**
 * Parse a transcript body that may be a byte-truncated tail.
 *
 * Only lines provable complete by newline boundaries are used:
 *   - a leading fragment cannot be parsed as JSON → dropped, droppedLeadingPartial
 *   - text after the final newline is unterminated → dropped, droppedTrailingPartial
 *
 * @param {string|Buffer|Uint8Array} input
 * @param {{}} [options]
 */
export function parseTranscriptTail(input, options = {}) {
  void options;
  const result = {
    turns: [],
    droppedLeadingPartial: false,
    droppedTrailingPartial: false,
    // Additive metadata (the frozen keys above are unchanged); callers that
    // need stable title/cwd provenance use the bounded file readers below.
    sessionTitle: null,
    sessionId: null,
    cwd: null,
  };

  const text = decodeInput(input);
  if (!text) return result;

  const lastNewline = text.lastIndexOf("\n");
  let body = text;
  if (lastNewline === -1) {
    // Nothing is newline-terminated: the whole buffer is an unterminated line.
    result.droppedTrailingPartial = text.trim().length > 0;
    return result;
  }
  if (lastNewline !== text.length - 1) {
    result.droppedTrailingPartial = text.slice(lastNewline + 1).trim().length > 0;
    body = text.slice(0, lastNewline + 1);
  }

  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return result;

  let pending = null;
  const flush = () => {
    if (!pending) return;
    // The contract requires a non-empty reply (server min(1)); a trailing user
    // message with no assistant answer yet is not a turn.
    if (pending.replyParts.length > 0) {
      result.turns.push({
        userMessageId: pending.userMessageId,
        promptText: pending.promptText,
        replyText: pending.replyParts.join("\n\n"),
        userTimestamp: pending.userTimestamp,
      });
    }
    pending = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    let row;
    try {
      row = JSON.parse(lines[index]);
    } catch {
      // A byte-truncated head is unparseable; anything later is a corrupt line.
      if (index === 0) result.droppedLeadingPartial = true;
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;

    if (
      !result.sessionTitle &&
      row.type === "ai-title" &&
      typeof row.aiTitle === "string" &&
      row.aiTitle.trim()
    ) {
      result.sessionTitle = row.aiTitle.trim();
      continue;
    }
    if (
      !result.sessionTitle &&
      row.type === "custom-title" &&
      typeof row.customTitle === "string" &&
      row.customTitle.trim()
    ) {
      result.sessionTitle = row.customTitle.trim();
      continue;
    }
    if (row.type !== "message") continue;
    if (row.role !== "user" && row.role !== "assistant") continue;

    if (!result.sessionId && typeof row.sessionId === "string" && row.sessionId) {
      result.sessionId = row.sessionId;
    }
    if (!result.cwd && typeof row.cwd === "string" && row.cwd) result.cwd = row.cwd;

    const text_ = extractMessageText(row.content);
    if (!text_) {
      // An image-only user message is a genuine new turn, but has no uploadable
      // prompt text. Close the preceding turn before discarding it so the image
      // reply cannot be incorrectly attached to that earlier prompt.
      if (row.role === "user") flush();
      continue;
    }

    if (row.role === "user") {
      const promptText = extractUserQuery(text_);
      // A row that carries nothing but injected reminders (WorkBuddy's automatic
      // "please continue" after a stream error) is not a new round: the assistant
      // text that follows belongs to the question already in flight.
      if (!promptText) continue;
      flush();
      pending = {
        userMessageId: typeof row.id === "string" ? row.id : "",
        promptText,
        userTimestamp: Number.isFinite(row.timestamp) ? row.timestamp : null,
        replyParts: [],
      };
      continue;
    }

    // assistant: joins the open turn; assistant text before any user message in a
    // truncated tail has no user id to key on, so it is unusable.
    if (pending) pending.replyParts.push(text_);
  }

  flush();
  result.turns = result.turns.filter((turn) => turn.userMessageId);
  return result;
}

/**
 * Shape one parsed turn into a server ingest event.
 *
 * Shared by the Stop hook and `workbuddy-sync import` so both paths produce
 * byte-identical payloads for the same turn (that is what makes the overlap
 * between live sync and backfill idempotent).
 */
export function buildTurnEvent({ turn, sourceSessionKey, sessionTitle, cwd, eventId }) {
  // Redact before applying the server length contract: truncating first could
  // retain a credential's middle while cutting off the evidence that it was hidden.
  const maskedPrompt = redactCredentialsForContract(turn.promptText);
  const maskedReply = redactCredentialsForContract(turn.replyText);
  const prompt = truncateForContract(
    maskedPrompt.text,
    PROMPT_MAX_LENGTH,
    maskedPrompt.protectedRanges,
  );
  const reply = truncateForContract(
    maskedReply.text,
    REPLY_MAX_LENGTH,
    maskedReply.protectedRanges,
  );
  if (!prompt.text.trim() || !reply.text.trim()) return null;

  const key = truncateForContract(sourceSessionKey, SOURCE_SESSION_KEY_MAX_LENGTH);
  if (!key.text.trim()) return null;

  const title = truncateForContract(
    resolveSessionTitle(sessionTitle, cwd),
    SESSION_TITLE_MAX_LENGTH,
  );

  const event = {
    event_id: eventId,
    source: "connector",
    source_session_key: key.text,
    session_title: title.text,
    prompt: prompt.text,
    reply: reply.text,
  };
  if (Number.isFinite(turn.userTimestamp) && turn.userTimestamp > 0) {
    const createdAt = new Date(turn.userTimestamp);
    // Date#toISOString throws for finite numbers outside JavaScript's Date
    // range. A malformed timestamp must only omit this optional field, never
    // abort the remaining transcript import.
    if (Number.isFinite(createdAt.getTime())) event.client_created_at = createdAt.toISOString();
  }
  return event;
}

/** First `ai-title` / `custom-title` row in the given JSONL text, or null. */
export function findSessionTitle(input) {
  const text = decodeInput(input);
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (row.type === "ai-title" && typeof row.aiTitle === "string" && row.aiTitle.trim()) {
      return row.aiTitle.trim();
    } else if (
      row.type === "custom-title" &&
      typeof row.customTitle === "string" &&
      row.customTitle.trim()
    ) {
      return row.customTitle.trim();
    }
  }
  return null;
}

/**
 * Resolve a transcript's immutable title with a sequential bounded-memory scan.
 *
 * WorkBuddy writes `ai-title` after the first turn, but a large first prompt can
 * put it beyond the original 64 KiB view. Scanning from byte zero is the only
 * way to distinguish that initial title from a later `custom-title` rename.
 * Chunks and retained partial lines are bounded, and the Stop hook races this
 * shared helper against its absolute deadline before falling back to the
 * constant title. Both live and import paths therefore share the same source.
 *
 * `fs` is injected (node:fs/promises shape: `open` → handle with `stat`/`read`/
 * `close`) so the Stop hook and `import` can call the identical code path.
 */
export async function readSessionTitle(fs, path) {
  const handle = await fs.open(path, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    const size = Number(stats.size);
    if (!Number.isFinite(size) || size <= 0) return null;

    const readRange = async (position, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return { buffer: buffer.subarray(0, bytesRead), bytesRead };
    };

    let position = 0;
    let remainder = "";
    let skippingLongLine = false;
    const decoder = new StringDecoder("utf8");
    while (position < size) {
      const length = Math.min(TITLE_HEAD_BYTES, size - position);
      const { buffer, bytesRead } = await readRange(position, length);
      if (!bytesRead) break;
      position += bytesRead;
      const chunk = decoder.write(buffer);
      let text = skippingLongLine ? chunk : remainder + chunk;
      if (skippingLongLine) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline === -1) continue;
        text = text.slice(firstNewline + 1);
        skippingLongLine = false;
      }
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) {
        remainder = text;
        if (Buffer.byteLength(remainder, "utf8") > TITLE_TAIL_BYTES) {
          // A title row is small; do not let an unrelated huge tool JSON row
          // defeat bounded memory while we wait for its terminal newline.
          remainder = "";
          skippingLongLine = true;
        }
        continue;
      }
      const title = findSessionTitle(text.slice(0, lastNewline + 1));
      if (title) return title;
      remainder = text.slice(lastNewline + 1);
      if (Buffer.byteLength(remainder, "utf8") > TITLE_TAIL_BYTES) {
        remainder = "";
        skippingLongLine = true;
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Return the cwd from the transcript's first complete `message` row.
 *
 * This is intentionally independent of a Stop hook's stdin payload: that
 * payload can reflect a later workspace. Scan only a bounded head so hook
 * latency remains capped; if no first message is found in that view, callers
 * use the constant title fallback rather than guessing from later rows.
 */
export async function readSessionCwd(fs, path) {
  const handle = await fs.open(path, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    const size = Number(stats.size);
    if (!Number.isFinite(size) || size <= 0) return null;

    const limit = Math.min(size, CWD_HEAD_MAX_BYTES);
    let position = 0;
    let remainder = "";
    const decoder = new StringDecoder("utf8");
    while (position < limit) {
      const length = Math.min(CWD_HEAD_CHUNK_BYTES, limit - position);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const text = remainder + decoder.write(buffer.subarray(0, bytesRead));
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline === -1) {
        remainder = text;
        continue;
      }
      remainder = text.slice(lastNewline + 1);
      for (const line of text.slice(0, lastNewline).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let row;
        try {
          row = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!row || typeof row !== "object" || Array.isArray(row) || row.type !== "message") {
          continue;
        }
        return typeof row.cwd === "string" && row.cwd.trim() ? row.cwd.trim() : null;
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** Transcript title → workspace folder name → constant fallback. */
export function resolveSessionTitle(sessionTitle, cwd) {
  if (typeof sessionTitle === "string" && sessionTitle.trim()) return sessionTitle.trim();
  if (typeof cwd === "string" && cwd.trim()) {
    const segments = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
    const base = segments[segments.length - 1];
    if (base && base.trim()) return base.trim();
  }
  return DEFAULT_SESSION_TITLE;
}

export { DEFAULT_SESSION_TITLE };
