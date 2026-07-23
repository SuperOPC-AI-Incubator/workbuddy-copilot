import { createHash } from "node:crypto";

const INTERNAL_AUTH_DOMAIN = "auth.copilot.sg.superbrain-ai.com";
const MENTOR_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function normalizeMentorUsername(username: string): string {
  const normalized = normalize(username);

  if (!MENTOR_USERNAME_PATTERN.test(normalized)) {
    throw new Error("用户名格式不正确");
  }

  return normalized;
}

export function mentorUsernameToEmail(username: string): string {
  const normalized = normalizeMentorUsername(username);
  const digest = createHash("sha256").update(normalized).digest("base64url");

  return `u1_${digest}@${INTERNAL_AUTH_DOMAIN}`;
}

export function loginIdentifierToEmail(identifier: string): string {
  const normalized = normalize(identifier);

  if (normalized.includes("@")) {
    if (normalized.endsWith(`@${INTERNAL_AUTH_DOMAIN}`)) {
      throw new Error("账号格式不正确");
    }

    return normalized;
  }

  return mentorUsernameToEmail(normalized);
}
