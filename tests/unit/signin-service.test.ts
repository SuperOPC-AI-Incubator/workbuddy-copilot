import { describe, expect, test } from "vitest";

import { mentorUsernameToEmail } from "@/lib/auth/identifiers";
import {
  classifySupabaseAuthError,
  createSignInService,
  type AppRole,
  type AuthenticatedPasswordSession,
  type SignInGateway,
  SignInGatewayError,
  type StudentAccount,
  type TrustedStaffAccount,
} from "@/lib/auth/signin.server";

const userId = "11111111-1111-4111-8111-111111111111";
const testPassword = "not-a-real-password";

function createGateway(
  options: {
    roles?: AppRole[];
    staff?: TrustedStaffAccount | null;
    student?: StudentAccount | null;
    authError?: Error;
  } = {},
): SignInGateway & { passwordAttempts: Array<{ email: string; password: string }> } {
  const passwordAttempts: Array<{ email: string; password: string }> = [];
  const session: AuthenticatedPasswordSession = {
    userId,
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: 1_800_000_000,
  };

  return {
    passwordAttempts,
    async authenticateWithPassword(input) {
      passwordAttempts.push(input);
      if (options.authError) throw options.authError;
      return session;
    },
    async getRoles() {
      return options.roles ?? ["mentor"];
    },
    async getStaffAccount() {
      return options.staff === undefined
        ? {
            username: "demo.mentor",
            isActive: true,
            mustChangePassword: false,
          }
        : options.staff;
    },
    async getStudentAccount() {
      return options.student ?? null;
    },
  };
}

describe("sign-in service", () => {
  test.each([
    [{ code: "invalid_credentials", status: 400 }, "invalid_credentials"],
    [{ code: "user_banned", status: 400 }, "account_unavailable"],
    [{ code: "over_request_rate_limit", status: 429 }, "rate_limited"],
    [{ status: 503 }, "service_unavailable"],
    [new TypeError("network failed"), "service_unavailable"],
  ] as const)("classifies Supabase auth failure %o as %s", (failure, expectedKind) => {
    expect(classifySupabaseAuthError(failure).kind).toBe(expectedKind);
  });

  test("maps a username before calling password authentication", async () => {
    const gateway = createGateway();
    const signIn = createSignInService(gateway);

    await signIn({ identifier: " Demo.Mentor ", password: testPassword });

    expect(gateway.passwordAttempts).toEqual([
      {
        email: mentorUsernameToEmail("demo.mentor"),
        password: testPassword,
      },
    ]);
  });

  test("returns only the public DTO and never the internal identity or password", async () => {
    const gateway = createGateway();
    const signIn = createSignInService(gateway);
    const internalEmail = mentorUsernameToEmail("demo.mentor");

    const result = await signIn({ identifier: "demo.mentor", password: testPassword });
    const serialized = JSON.stringify(result);

    expect(Object.keys(result).sort()).toEqual([
      "access_token",
      "expires_at",
      "public",
      "refresh_token",
    ]);
    expect(Object.keys(result.public).sort()).toEqual([
      "accountType",
      "displayName",
      "mustChangePassword",
      "roles",
      "userId",
    ]);
    expect(serialized).not.toContain(internalEmail);
    expect(serialized).not.toContain(testPassword);
    expect(serialized).not.toContain('"email"');
    expect(serialized).not.toContain('"password"');
  });

  test("resolves a student profile for normal email login", async () => {
    const gateway = createGateway({
      roles: ["student"],
      staff: null,
      student: { displayName: "测试学员" },
    });
    const signIn = createSignInService(gateway);

    const result = await signIn({
      identifier: " Learner@Example.COM ",
      password: testPassword,
    });

    expect(gateway.passwordAttempts[0]?.email).toBe("learner@example.com");
    expect(result.public).toEqual({
      userId,
      accountType: "student",
      displayName: "测试学员",
      roles: ["student"],
      mustChangePassword: false,
    });
  });

  test("rejects a disabled staff account with a generic safe error", async () => {
    const gateway = createGateway({
      staff: {
        username: "demo.mentor",
        isActive: false,
        mustChangePassword: false,
      },
    });
    const signIn = createSignInService(gateway);

    await expect(signIn({ identifier: "demo.mentor", password: testPassword })).rejects.toThrow(
      "账号不可用，请联系管理员",
    );
  });

  test("rejects username login when authentication has no matching staff account", async () => {
    const gateway = createGateway({
      roles: ["student"],
      staff: null,
      student: { displayName: "测试学员" },
    });
    const signIn = createSignInService(gateway);

    await expect(signIn({ identifier: "demo.mentor", password: testPassword })).rejects.toThrow(
      "账号不可用，请联系管理员",
    );
  });

  test("rejects a staff account without a mentor or team-admin role", async () => {
    const gateway = createGateway({
      roles: [],
    });
    const signIn = createSignInService(gateway);

    await expect(signIn({ identifier: "demo.mentor", password: testPassword })).rejects.toThrow(
      "账号不可用，请联系管理员",
    );
  });

  test("rejects a student profile without the student role", async () => {
    const gateway = createGateway({
      roles: [],
      staff: null,
      student: { displayName: "测试学员" },
    });
    const signIn = createSignInService(gateway);

    await expect(
      signIn({ identifier: "learner@example.com", password: testPassword }),
    ).rejects.toThrow("账号不可用，请联系管理员");
  });

  test("rejects a student role without a student profile", async () => {
    const gateway = createGateway({
      roles: ["student"],
      staff: null,
      student: null,
    });
    const signIn = createSignInService(gateway);

    await expect(
      signIn({ identifier: "learner@example.com", password: testPassword }),
    ).rejects.toThrow("账号不可用，请联系管理员");
  });

  test("rejects a hybrid staff and student identity", async () => {
    const gateway = createGateway({
      roles: ["mentor", "student"],
      student: { displayName: "冲突账号" },
    });
    const signIn = createSignInService(gateway);

    await expect(signIn({ identifier: "demo.mentor", password: testPassword })).rejects.toThrow(
      "账号不可用，请联系管理员",
    );
  });

  test("preserves the staff must-change-password flag", async () => {
    const gateway = createGateway({
      roles: ["mentor", "team_admin"],
      staff: {
        username: "demo.mentor",
        isActive: true,
        mustChangePassword: true,
      },
    });
    const signIn = createSignInService(gateway);

    const result = await signIn({
      identifier: "demo.mentor",
      password: testPassword,
    });

    expect(result.public.mustChangePassword).toBe(true);
    expect(result.public.roles).toEqual(["mentor", "team_admin"]);
  });

  test("maps password-auth failure to a stable safe error", async () => {
    const gateway = createGateway({
      authError: new SignInGatewayError("invalid_credentials"),
    });
    const signIn = createSignInService(gateway);

    const promise = signIn({ identifier: "demo.mentor", password: testPassword });

    await expect(promise).rejects.toThrow("账号或密码错误");
  });

  test("maps account-state auth failure to a generic unavailable error", async () => {
    const gateway = createGateway({
      authError: new SignInGatewayError("account_unavailable"),
    });
    const signIn = createSignInService(gateway);

    await expect(signIn({ identifier: "demo.mentor", password: testPassword })).rejects.toThrow(
      "账号不可用，请联系管理员",
    );
  });

  test("maps rate limits to a retry-later error", async () => {
    const gateway = createGateway({
      authError: new SignInGatewayError("rate_limited"),
    });
    const signIn = createSignInService(gateway);

    await expect(signIn({ identifier: "demo.mentor", password: testPassword })).rejects.toThrow(
      "尝试次数过多，请稍后重试",
    );
  });

  test("maps network and server failures to service unavailable", async () => {
    const gateway = createGateway({
      authError: new SignInGatewayError("service_unavailable"),
    });
    const signIn = createSignInService(gateway);

    await expect(signIn({ identifier: "demo.mentor", password: testPassword })).rejects.toThrow(
      "认证服务暂时不可用",
    );
  });

  test("does not misclassify unknown raw gateway errors as invalid credentials", async () => {
    const internalEmail = mentorUsernameToEmail("demo.mentor");
    const gateway = createGateway({
      authError: new Error(`Unexpected upstream failure for ${internalEmail}`),
    });
    const signIn = createSignInService(gateway);

    const promise = signIn({ identifier: "demo.mentor", password: testPassword });

    await expect(promise).rejects.toThrow("认证服务暂时不可用");
    await expect(promise).rejects.not.toThrow(internalEmail);
  });
});
