import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createPasswordChangeService,
  type PasswordChangeGateway,
} from "@/lib/auth/password-change.server";

const userId = "10000000-0000-0000-0000-000000000103";
const newPassword = "correct horse battery staple";
const replacementSession = {
  accessToken: "replacement-access-token",
  refreshToken: "replacement-refresh-token",
  expiresAt: 1_999_999_999,
};

type GatewayState = {
  authCalls: Array<{ userId: string; password: string }>;
  completionCalls: string[];
  sessionCalls: Array<{ userId: string; password: string }>;
  failAuth?: boolean;
  failCompletion?: boolean;
  failSession?: boolean;
};

function createGateway(state: GatewayState): PasswordChangeGateway {
  return {
    async updateAuthPassword(actualUserId, password) {
      state.authCalls.push({ userId: actualUserId, password });
      if (state.failAuth) {
        throw new Error(`upstream auth rejected secret: ${password}`);
      }
    },
    async completePasswordChange(actualUserId) {
      state.completionCalls.push(actualUserId);
      if (state.failCompletion) {
        throw new Error(`database unavailable for ${actualUserId}`);
      }
    },
    async createPasswordSession(actualUserId, password) {
      state.sessionCalls.push({ userId: actualUserId, password });
      if (state.failSession) {
        throw new Error(`replacement session rejected secret: ${password}`);
      }
      return replacementSession;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("password-change service", () => {
  test("updates Auth, clears the flag, then creates a replacement session", async () => {
    const events: string[] = [];
    const gateway: PasswordChangeGateway = {
      async updateAuthPassword(actualUserId) {
        events.push(`auth:${actualUserId}`);
      },
      async completePasswordChange(actualUserId) {
        events.push(`complete:${actualUserId}`);
      },
      async createPasswordSession(actualUserId) {
        events.push(`session:${actualUserId}`);
        return replacementSession;
      },
    };
    const changePassword = createPasswordChangeService(gateway);

    const result = await changePassword({ userId, newPassword });

    expect(events).toEqual([`auth:${userId}`, `complete:${userId}`, `session:${userId}`]);
    expect(result).toEqual({ ok: true, session: replacementSession });
  });

  test("does not clear the flag when the Auth password update fails", async () => {
    const state: GatewayState = {
      authCalls: [],
      completionCalls: [],
      sessionCalls: [],
      failAuth: true,
    };
    const changePassword = createPasswordChangeService(createGateway(state));

    await expect(changePassword({ userId, newPassword })).rejects.toThrow(
      "密码更新失败，请稍后重试。",
    );

    expect(state.completionCalls).toEqual([]);
    expect(state.sessionCalls).toEqual([]);
  });

  test("uses only the authenticated context user ID for both operations", async () => {
    const state: GatewayState = {
      authCalls: [],
      completionCalls: [],
      sessionCalls: [],
    };
    const changePassword = createPasswordChangeService(createGateway(state));

    await changePassword({ userId, newPassword });

    expect(state.authCalls).toEqual([{ userId, password: newPassword }]);
    expect(state.completionCalls).toEqual([userId]);
    expect(state.sessionCalls).toEqual([{ userId, password: newPassword }]);
  });

  test("maps a completion failure safely after Auth succeeds", async () => {
    const state: GatewayState = {
      authCalls: [],
      completionCalls: [],
      sessionCalls: [],
      failCompletion: true,
    };
    const changePassword = createPasswordChangeService(createGateway(state));

    await expect(changePassword({ userId, newPassword })).rejects.toThrow(
      "密码已更新，但账号状态确认失败，请重试。",
    );

    expect(state.authCalls).toHaveLength(1);
    expect(state.completionCalls).toEqual([userId]);
    expect(state.sessionCalls).toEqual([]);
  });

  test("maps replacement-session failure without exposing the new password", async () => {
    const state: GatewayState = {
      authCalls: [],
      completionCalls: [],
      sessionCalls: [],
      failSession: true,
    };
    const changePassword = createPasswordChangeService(createGateway(state));

    await expect(changePassword({ userId, newPassword })).rejects.toThrow(
      "密码已更新，请使用新密码重新登录。",
    );

    expect(state.authCalls).toHaveLength(1);
    expect(state.completionCalls).toEqual([userId]);
    expect(state.sessionCalls).toEqual([{ userId, password: newPassword }]);
  });

  test("never returns or logs the password or raw upstream errors", async () => {
    const logSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const successState: GatewayState = {
      authCalls: [],
      completionCalls: [],
      sessionCalls: [],
    };
    const successfulChange = createPasswordChangeService(createGateway(successState));

    const result = await successfulChange({ userId, newPassword });

    expect(JSON.stringify(result)).not.toContain(newPassword);
    expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);

    const failureState: GatewayState = {
      authCalls: [],
      completionCalls: [],
      sessionCalls: [],
      failAuth: true,
    };
    const failedChange = createPasswordChangeService(createGateway(failureState));
    const failure = await failedChange({ userId, newPassword }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(newPassword);
    expect((failure as Error).message).not.toContain("upstream");
    expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });
});
