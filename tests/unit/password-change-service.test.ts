import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createPasswordChangeService,
  type PasswordChangeGateway,
} from "@/lib/auth/password-change.server";

const userId = "10000000-0000-0000-0000-000000000103";
const newPassword = "correct horse battery staple";

type GatewayState = {
  authCalls: Array<{ userId: string; password: string }>;
  completionCalls: string[];
  failAuth?: boolean;
  failCompletion?: boolean;
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
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("password-change service", () => {
  test("updates Auth before clearing the flag for the authenticated user", async () => {
    const events: string[] = [];
    const gateway: PasswordChangeGateway = {
      async updateAuthPassword(actualUserId) {
        events.push(`auth:${actualUserId}`);
      },
      async completePasswordChange(actualUserId) {
        events.push(`complete:${actualUserId}`);
      },
    };
    const changePassword = createPasswordChangeService(gateway);

    const result = await changePassword({ userId, newPassword });

    expect(events).toEqual([`auth:${userId}`, `complete:${userId}`]);
    expect(result).toEqual({ ok: true });
  });

  test("does not clear the flag when the Auth password update fails", async () => {
    const state: GatewayState = {
      authCalls: [],
      completionCalls: [],
      failAuth: true,
    };
    const changePassword = createPasswordChangeService(createGateway(state));

    await expect(changePassword({ userId, newPassword })).rejects.toThrow(
      "密码更新失败，请稍后重试。",
    );

    expect(state.completionCalls).toEqual([]);
  });

  test("uses only the authenticated context user ID for both operations", async () => {
    const state: GatewayState = {
      authCalls: [],
      completionCalls: [],
    };
    const changePassword = createPasswordChangeService(createGateway(state));

    await changePassword({ userId, newPassword });

    expect(state.authCalls).toEqual([{ userId, password: newPassword }]);
    expect(state.completionCalls).toEqual([userId]);
  });

  test("maps a completion failure safely after Auth succeeds", async () => {
    const state: GatewayState = {
      authCalls: [],
      completionCalls: [],
      failCompletion: true,
    };
    const changePassword = createPasswordChangeService(createGateway(state));

    await expect(changePassword({ userId, newPassword })).rejects.toThrow(
      "密码已更新，但账号状态确认失败，请重试。",
    );

    expect(state.authCalls).toHaveLength(1);
    expect(state.completionCalls).toEqual([userId]);
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
    };
    const successfulChange = createPasswordChangeService(createGateway(successState));

    const result = await successfulChange({ userId, newPassword });

    expect(JSON.stringify(result)).not.toContain(newPassword);
    expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);

    const failureState: GatewayState = {
      authCalls: [],
      completionCalls: [],
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
