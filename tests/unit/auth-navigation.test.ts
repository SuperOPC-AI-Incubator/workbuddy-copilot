import { describe, expect, test } from "vitest";

import {
  buildChangePasswordHref,
  getStaffAccessDecision,
  safeInternalPath,
  safePostAuthPath,
} from "@/lib/auth/navigation";

describe("authentication navigation", () => {
  test("preserves an allowed internal pathname, search, and hash", () => {
    expect(safeInternalPath("/workbuddy?tab=setup#token")).toBe("/workbuddy?tab=setup#token");
  });

  test.each([
    "//evil.example/path",
    "/\\evil.example/path",
    "https://evil.example/path",
    "javascript:alert(1)",
    "/%5cevil.example/path",
    "/%2f%2fevil.example/path",
  ])("rejects unsafe redirect %s", (candidate) => {
    expect(safeInternalPath(candidate, "/fallback")).toBe("/fallback");
  });

  test("prevents post-auth loops through auth management routes", () => {
    expect(safePostAuthPath("/auth?next=/workbuddy")).toBe("/");
    expect(safePostAuthPath("/change-password?next=/workbuddy")).toBe("/");
    expect(safePostAuthPath("/workbuddy?tab=setup")).toBe("/workbuddy?tab=setup");
  });

  test("builds a change-password URL with an encoded safe next path", () => {
    expect(buildChangePasswordHref("/workbuddy?tab=setup#token")).toBe(
      "/change-password?next=%2Fworkbuddy%3Ftab%3Dsetup%23token",
    );
    expect(buildChangePasswordHref("//evil.example")).toBe("/change-password?next=%2F");
  });

  test("forces active staff through password change before protected routes", () => {
    expect(
      getStaffAccessDecision({
        isActive: true,
        mustChangePassword: true,
      }),
    ).toBe("change_password");
    expect(
      getStaffAccessDecision({
        isActive: true,
        mustChangePassword: false,
      }),
    ).toBe("allow");
  });

  test("signs disabled staff out before protected routes", () => {
    expect(
      getStaffAccessDecision({
        isActive: false,
        mustChangePassword: true,
      }),
    ).toBe("sign_out");
  });
});
