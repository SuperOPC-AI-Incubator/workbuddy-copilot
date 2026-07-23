import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const authRoutePath = resolve(process.cwd(), "src/routes/auth.tsx");
const protectedRoutePath = resolve(process.cwd(), "src/routes/_authenticated/route.tsx");
const changePasswordRoutePath = resolve(process.cwd(), "src/routes/change-password.tsx");
const changePasswordFunctionsPath = resolve(
  process.cwd(),
  "src/lib/auth/password-change.functions.ts",
);
const changePasswordServerPath = resolve(process.cwd(), "src/lib/auth/password-change.server.ts");

const authRoute = readFileSync(authRoutePath, "utf8");
const protectedRoute = readFileSync(protectedRoutePath, "utf8");

describe("authentication route contract", () => {
  test("guards every authenticated route with current staff status", () => {
    expect(protectedRoute).toMatch(
      /\.from\s*\(\s*"staff_accounts"\s*\)[\s\S]*?\.select\s*\(\s*"is_active, must_change_password"\s*\)/,
    );
    expect(protectedRoute).toContain("getStaffAccessDecision");
    expect(protectedRoute).toContain('to: "/change-password"');
    expect(protectedRoute).toContain("supabase.auth.signOut()");
  });

  test("uses tested internal paths and router navigation after sign-in", () => {
    expect(authRoute).toContain("safePostAuthPath");
    expect(authRoute).toContain("buildChangePasswordHref");
    expect(authRoute).toMatch(
      /navigate\s*\(\s*\{\s*href:\s*destination,\s*replace:\s*true\s*\}\s*\)/,
    );
    expect(authRoute).not.toContain("window.location.replace");
  });

  test("provides a root-level session-required password-change route", () => {
    expect(existsSync(changePasswordRoutePath)).toBe(true);

    const changePasswordRoute = readFileSync(changePasswordRoutePath, "utf8");
    expect(changePasswordRoute).toContain('createFileRoute("/change-password")');
    expect(changePasswordRoute).toContain("supabase.auth.getUser()");
    expect(changePasswordRoute).toContain("useServerFn(changeOwnPassword)");
    expect(changePasswordRoute).not.toContain("supabase.auth.updateUser");
    expect(changePasswordRoute).not.toMatch(/supabase\.rpc\s*\(/);
    expect(changePasswordRoute).toContain("safePostAuthPath");
    expect(changePasswordRoute).toContain("supabase.auth.setSession");
    expect(changePasswordRoute).not.toContain("supabase.auth.refreshSession");
    expect(changePasswordRoute).toMatch(
      /navigate\s*\(\s*\{\s*href:\s*safeNext,\s*replace:\s*true\s*\}\s*\)/,
    );
  });

  test("keeps password mutation behind authenticated server-only orchestration", () => {
    expect(existsSync(changePasswordFunctionsPath)).toBe(true);
    expect(existsSync(changePasswordServerPath)).toBe(true);

    const functionsSource = readFileSync(changePasswordFunctionsPath, "utf8");
    const serverSource = readFileSync(changePasswordServerPath, "utf8");

    expect(functionsSource).toContain('createServerFn({ method: "POST" })');
    expect(functionsSource).toContain(".middleware([requireSupabaseAuth])");
    expect(functionsSource).toMatch(
      /z\.object\s*\(\s*\{\s*newPassword:\s*z\.string\(\)\.min\(8\)\.max\(256\)/,
    );
    expect(functionsSource).toContain('await import("./password-change.server")');
    expect(functionsSource).not.toMatch(/from\s+["']\.\/password-change\.server["']/);

    const authUpdate = serverSource.indexOf("auth.admin.updateUserById");
    const flagCompletion = serverSource.indexOf('"complete_staff_password_change"');
    expect(authUpdate).toBeGreaterThanOrEqual(0);
    expect(flagCompletion).toBeGreaterThan(authUpdate);
    expect(serverSource).not.toContain("console.");
  });
});
