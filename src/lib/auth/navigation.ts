const VALIDATION_ORIGIN = "https://workbuddy.invalid";
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/i;

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function validatedInternalPath(candidate: unknown): string | null {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return null;
  if (candidate.includes("\\") || containsControlCharacter(candidate)) return null;
  if (ENCODED_PATH_SEPARATOR.test(candidate)) return null;

  try {
    decodeURIComponent(candidate);
    const url = new URL(candidate, VALIDATION_ORIGIN);
    if (url.origin !== VALIDATION_ORIGIN) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function safeInternalPath(candidate: unknown, fallback = "/"): string {
  return validatedInternalPath(candidate) ?? validatedInternalPath(fallback) ?? "/";
}

export function safePostAuthPath(candidate: unknown): string {
  const path = safeInternalPath(candidate);
  const pathname = new URL(path, VALIDATION_ORIGIN).pathname;

  if (pathname === "/auth" || pathname === "/change-password") {
    return "/";
  }

  return path;
}

export function buildChangePasswordHref(next: unknown): string {
  const search = new URLSearchParams({ next: safePostAuthPath(next) });
  return `/change-password?${search.toString()}`;
}

export type StaffAccessDecision = "allow" | "change_password" | "sign_out";

export function getStaffAccessDecision(
  staff: { isActive: boolean; mustChangePassword: boolean } | null,
): StaffAccessDecision {
  if (!staff) return "allow";
  if (!staff.isActive) return "sign_out";
  return staff.mustChangePassword ? "change_password" : "allow";
}
