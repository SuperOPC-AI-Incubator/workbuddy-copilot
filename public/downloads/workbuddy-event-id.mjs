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

const VISIBLE_CREDENTIAL_CHARS = 4;

function maskCredential(value, prefixLength = 0) {
  const prefix = value.slice(0, prefixLength);
  const remainder = value.slice(prefixLength);
  const visibleStart = remainder.slice(0, VISIBLE_CREDENTIAL_CHARS);
  const visibleEnd = remainder.slice(-VISIBLE_CREDENTIAL_CHARS);
  const hiddenLength = Math.max(0, remainder.length - visibleStart.length - visibleEnd.length);
  return `${prefix}${visibleStart}…[已隐藏 ${hiddenLength} 位]…${visibleEnd}`;
}

function maskPrivateKeyBlock(value) {
  const begin = value.match(/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/)?.[0];
  const end = value.match(/-----END [A-Z0-9 ]*PRIVATE KEY-----$/)?.[0];
  if (!begin || !end) return maskCredential(value);
  const body = value.slice(begin.length, value.length - end.length);
  return `${begin}…[已隐藏 ${body.length} 位]…${end}`;
}

function hasHighEntropy(value) {
  if (value.length < 24) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(value),
  ).length;
  return classes >= 2 && new Set(value).size >= 8;
}

function hasKnownCredentialPrefix(value) {
  return /^(?:sk-(?:proj-|ant-)?|gh[ops]_|github_pat_|AKIA|AIza|xox[baprs]-|wb_|sb_(?:secret|publishable)_|eyJ)/.test(
    value,
  );
}

const CREDENTIAL_PATTERNS = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: (match) => maskPrivateKeyBlock(match[0]),
  },
  {
    pattern: /\bsk-proj-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
    replace: (match) => maskCredential(match[0], 8),
  },
  {
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
    replace: (match) => maskCredential(match[0], 7),
  },
  {
    pattern: /\bsk-(?!proj-|ant-)[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g,
    replace: (match) => maskCredential(match[0], 3),
  },
  { pattern: /\bghp_[A-Za-z0-9_]{20,}\b/g, replace: (match) => maskCredential(match[0], 4) },
  { pattern: /\bgho_[A-Za-z0-9_]{20,}\b/g, replace: (match) => maskCredential(match[0], 4) },
  { pattern: /\bghs_[A-Za-z0-9_]{20,}\b/g, replace: (match) => maskCredential(match[0], 4) },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replace: (match) => maskCredential(match[0], 11),
  },
  {
    pattern:
      /\b(AKIA[0-9A-Z]{16})(?:[ \t]+|[ \t]*\r?\n[ \t]*|[ \t]*[:=,][ \t]*)([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/g,
    replace: (match) =>
      `${maskCredential(match[1], 4)}${match[0].slice(match[1].length, -match[2].length)}${maskCredential(match[2])}`,
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: (match) => maskCredential(match[0], 4) },
  {
    pattern: /\bAIza[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/g,
    replace: (match) => maskCredential(match[0], 4),
  },
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}(?![A-Za-z0-9-])/g,
    replace: (match) => maskCredential(match[0], 5),
  },
  {
    pattern: /\bwb_[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
    replace: (match) => maskCredential(match[0], 3),
  },
  {
    pattern: /\bsb_secret_[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
    replace: (match) => maskCredential(match[0], 10),
  },
  {
    pattern: /\bsb_publishable_[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
    replace: (match) => maskCredential(match[0], 15),
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g,
    replace: (match) => maskCredential(match[0], 3),
  },
  {
    pattern:
      /\b(?:aws_secret_access_key|api[_-]?key|access[_-]?token|secret(?:[_-]?(?:key|token))?|token|password)\b(\s*(?:=|:)\s*["']?)([A-Za-z0-9+/_=-]{24,})/gi,
    replace: (match) => {
      const secret = match[2];
      return `${match[0].slice(0, -secret.length)}${maskCredential(secret)}`;
    },
    valid: (match) => hasHighEntropy(match[2]) && !hasKnownCredentialPrefix(match[2]),
  },
  {
    pattern: /\bBearer(\s+)([A-Za-z0-9+/_=-]{24,})/gi,
    replace: (match) => `${match[0].slice(0, -match[2].length)}${maskCredential(match[2])}`,
    valid: (match) => hasHighEntropy(match[2]),
  },
];

function credentialMatches(value) {
  const candidates = [];
  for (let priority = 0; priority < CREDENTIAL_PATTERNS.length; priority += 1) {
    const candidate = CREDENTIAL_PATTERNS[priority];
    candidate.pattern.lastIndex = 0;
    let match;
    while ((match = candidate.pattern.exec(value))) {
      if (candidate.valid && !candidate.valid(match)) continue;
      const replacement = candidate.replace(match);
      if (!replacement || replacement === match[0]) continue;
      candidates.push({
        start: match.index,
        end: match.index + match[0].length,
        priority,
        replacement,
      });
    }
  }
  candidates.sort((left, right) => left.start - right.start || left.priority - right.priority);

  const matches = [];
  let consumed = 0;
  for (const candidate of candidates) {
    if (candidate.start < consumed) continue;
    matches.push(candidate);
    consumed = candidate.end;
  }
  return matches;
}

/**
 * Replace credential-shaped content before it leaves the device. The returned
 * ranges protect complete visible masks from being split by contract truncation.
 */
export function redactCredentialsForContract(text) {
  const value = typeof text === "string" ? text : String(text ?? "");
  const matches = credentialMatches(value);
  if (matches.length === 0) return { text: value, protectedRanges: [] };

  const protectedRanges = [];
  let cursor = 0;
  let masked = "";
  for (const match of matches) {
    masked += value.slice(cursor, match.start);
    const start = masked.length;
    masked += match.replacement;
    protectedRanges.push({ start, end: masked.length });
    cursor = match.end;
  }
  masked += value.slice(cursor);
  return { text: masked, protectedRanges };
}

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
export function truncateForContract(text, max, protectedRanges = []) {
  const value = typeof text === "string" ? text : String(text ?? "");
  const limit = Number.isInteger(max) && max > 0 ? max : 0;

  if (limit === 0) return { text: "", truncated: value.length > 0 };
  if (value.length <= limit) return { text: value, truncated: false };

  const budget = limit > TRUNCATION_MARKER.length ? limit - TRUNCATION_MARKER.length : limit;
  let cutAt = budget;
  for (const range of protectedRanges) {
    if (
      Number.isInteger(range?.start) &&
      Number.isInteger(range?.end) &&
      range.start < cutAt &&
      range.end > cutAt
    ) {
      cutAt = range.start;
    }
  }
  let head = value.slice(0, cutAt);
  // Never leave a dangling high surrogate behind: it would serialize as a lone
  // surrogate escape and could break strict UTF-8 consumers downstream.
  const lastCode = head.charCodeAt(head.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) head = head.slice(0, -1);

  const suffix = limit > TRUNCATION_MARKER.length ? TRUNCATION_MARKER : "";
  return { text: `${head}${suffix}`, truncated: true };
}
