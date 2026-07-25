/**
 * Deterministic event identity + contract-bound truncation for WorkBuddy turns.
 *
 * The hook (live Stop events) and `workbuddy-sync import` (backfill) both derive
 * event ids from the same inputs, so overlapping turns collapse into the same
 * idempotency key on the server instead of producing duplicates.
 */

import { createHash } from "node:crypto";

/** Visible marker appended when content is cut. Counts toward the limit. */
export const TRUNCATION_MARKER = "\n\n[…内容超出上限已截断]";

/**
 * Derive a stable RFC-4122-shaped identifier from (sessionId, userMessageId).
 *
 * SHA-256 of `${sessionId} ${userMessageId}`, first 16 bytes, with the version
 * nibble forced to 4 and the variant high bits forced into 8/9/a/b so the result
 * always satisfies the connector's UUID pattern.
 */
export function deriveEventId(sessionId, userMessageId) {
  const session = typeof sessionId === "string" ? sessionId : String(sessionId ?? "");
  const message = typeof userMessageId === "string" ? userMessageId : String(userMessageId ?? "");
  if (!session || !message) {
    throw new TypeError("deriveEventId requires a session id and a user message id");
  }

  const digest = createHash("sha256").update(`${session} ${message}`, "utf8").digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Cut text to the server contract limit, keeping the result a valid UTF-16
 * string and never exceeding `max` (the marker itself is counted).
 */
export function truncateForContract(text, max) {
  const value = typeof text === "string" ? text : String(text ?? "");
  const limit = Number.isInteger(max) && max > 0 ? max : 0;

  if (limit === 0) return { text: "", truncated: value.length > 0 };
  if (value.length <= limit) return { text: value, truncated: false };

  const budget = limit > TRUNCATION_MARKER.length ? limit - TRUNCATION_MARKER.length : limit;
  let head = value.slice(0, budget);
  // Never leave a dangling high surrogate behind: it would serialize as a lone
  // surrogate escape and could break strict UTF-8 consumers downstream.
  const lastCode = head.charCodeAt(head.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) head = head.slice(0, -1);

  const suffix = limit > TRUNCATION_MARKER.length ? TRUNCATION_MARKER : "";
  return { text: `${head}${suffix}`, truncated: true };
}
