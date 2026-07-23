import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";

import { mentorUsernameToEmail } from "@/lib/auth/identifiers";
import {
  AdminAuthGatewayError,
  AdminRepositoryError,
  classifyAuthAdminError,
  createMentorAdminService,
  type AdminAuthGateway,
  type MentorAdminActor,
  type MentorAdminRepository,
  type StaffAccountRecord,
} from "@/lib/auth/admin.server";

const callerId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const secondTargetId = "33333333-3333-4333-8333-333333333333";
const staffActor: MentorAdminActor = { kind: "staff", userId: callerId };
const bootstrapActor: MentorAdminActor = { kind: "trusted_bootstrap" };
const fixturePassword = ["fixture", "temporary", "9!"].join("-");

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function staffRecord(overrides: Partial<StaffAccountRecord> = {}): StaffAccountRecord {
  return {
    userId: targetId,
    username: "mentor.fixture",
    isActive: true,
    mustChangePassword: false,
    roles: ["mentor"],
    createdAt: "2026-07-20T08:00:00.000Z",
    disabledAt: null,
    ...overrides,
  };
}

function createHarness(
  options: {
    caller?: {
      isActive: boolean;
      mustChangePassword: boolean;
      roles: Array<"mentor" | "team_admin">;
    };
    staff?: StaffAccountRecord[];
    allowTrustedBootstrap?: boolean;
  } = {},
) {
  const events: string[] = [];
  const callerAuthorization = options.caller ?? {
    isActive: true,
    mustChangePassword: false,
    roles: ["mentor", "team_admin"] as Array<"mentor" | "team_admin">,
  };
  const authUsers = new Map<
    string,
    {
      id: string;
      lastSignInAt: string | null;
      bannedUntil: string | null;
      appMetadata: Record<string, unknown>;
    }
  >();
  const staff = new Map(
    (options.staff ?? [staffRecord({ userId: callerId, username: "admin.fixture" })]).map(
      (account) => [account.userId, { ...account }],
    ),
  );
  const createInputs: Parameters<AdminAuthGateway["createUser"]>[0][] = [];
  const updateInputs: Array<{
    id: string;
    input: Parameters<AdminAuthGateway["updateUser"]>[1];
  }> = [];
  const deletedIds: string[] = [];
  const passwordOperations = new Map<string, { token: string; previousValue: boolean }>();
  const activeOperations = new Map<string, { token: string; desiredActive: boolean }>();
  const activeVersions = new Map<string, number>();
  let authSequence = 0;
  let operationSequence = 0;
  const nextOperationToken = () =>
    `00000000-0000-4000-8000-${String(++operationSequence).padStart(12, "0")}`;

  const auth: AdminAuthGateway = {
    async createUser(input) {
      events.push("auth:create");
      createInputs.push(input);
      authSequence += 1;
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(authSequence).padStart(12, "0")}`;
      authUsers.set(id, {
        id,
        lastSignInAt: null,
        bannedUntil: null,
        appMetadata: input.appMetadata,
      });
      return id;
    },
    async updateUser(id, input) {
      events.push(
        input.banDuration === "none"
          ? "auth:unban"
          : input.banDuration
            ? "auth:ban"
            : "auth:password",
      );
      updateInputs.push({ id, input });
    },
    async deleteUser(id) {
      events.push("auth:delete");
      deletedIds.push(id);
      authUsers.delete(id);
    },
    async listUsers({ page }) {
      events.push(`auth:list:${page}`);
      return { users: [], nextPage: null };
    },
  };

  const repository: MentorAdminRepository = {
    async getCallerAuthorization() {
      return callerAuthorization;
    },
    async findStaffByUsername(username) {
      return [...staff.values()].find((account) => account.username === username) ?? null;
    },
    async listStaffAccounts() {
      events.push("db:list");
      return [...staff.values()];
    },
    async provisionStaffAccount(input) {
      events.push("db:provision");
      if (
        input.createdBy !== callerId ||
        !callerAuthorization.isActive ||
        callerAuthorization.mustChangePassword ||
        !callerAuthorization.roles.includes("team_admin")
      ) {
        throw new AdminRepositoryError("forbidden");
      }
      staff.set(
        input.userId,
        staffRecord({
          userId: input.userId,
          username: input.username,
          mustChangePassword: true,
          roles: input.isTeamAdmin ? ["mentor", "team_admin"] : ["mentor"],
        }),
      );
    },
    async bootstrapStaffAccount(input) {
      events.push("db:bootstrap");
      staff.set(
        input.userId,
        staffRecord({
          userId: input.userId,
          username: input.username,
          mustChangePassword: true,
          roles: input.isTeamAdmin ? ["mentor", "team_admin"] : ["mentor"],
        }),
      );
    },
    async beginStaffActiveOperation(input) {
      events.push(input.isActive ? "db:begin-enable" : "db:begin-disable");
      const account = staff.get(input.targetUserId);
      if (!account) throw new AdminRepositoryError("not_found");
      activeOperations.set(input.targetUserId, {
        token: input.operationToken,
        desiredActive: input.isActive,
      });
      activeVersions.set(input.targetUserId, (activeVersions.get(input.targetUserId) ?? 0) + 1);
      account.isActive = false;
      account.disabledAt ??= "2026-07-23T08:00:00.000Z";
    },
    async getStaffActiveSyncState(input) {
      events.push("db:active-state");
      const account = staff.get(input.targetUserId);
      if (!account) throw new AdminRepositoryError("not_found");
      const operation = activeOperations.get(input.targetUserId);
      return {
        version: activeVersions.get(input.targetUserId) ?? 0,
        operationToken: operation?.token ?? null,
        desiredActive: operation?.desiredActive ?? account.isActive,
      };
    },
    async confirmStaffActiveSync(input) {
      events.push("db:active-confirm");
      const account = staff.get(input.targetUserId);
      if (!account) throw new AdminRepositoryError("not_found");
      const operation = activeOperations.get(input.targetUserId);
      const version = activeVersions.get(input.targetUserId) ?? 0;
      if (
        input.observedVersion !== version ||
        input.operationToken !== (operation?.token ?? null)
      ) {
        return { confirmed: false, active: account.isActive };
      }
      if (operation) {
        account.isActive = operation.desiredActive;
        account.disabledAt = operation.desiredActive ? null : "2026-07-23T08:00:00.000Z";
        activeOperations.delete(input.targetUserId);
        activeVersions.set(input.targetUserId, version + 1);
      }
      return { confirmed: true, active: account.isActive };
    },
    async beginPasswordReset(input) {
      events.push("db:begin-password-reset");
      const account = staff.get(input.targetUserId);
      if (!account) throw new AdminRepositoryError("not_found");
      const previousValue = account.mustChangePassword;
      passwordOperations.set(input.targetUserId, {
        token: input.operationToken,
        previousValue,
      });
      account.mustChangePassword = true;
      return { previousValue };
    },
    async finishPasswordReset(input) {
      events.push(input.succeeded ? "db:finish-password-reset" : "db:compensate-password-reset");
      const account = staff.get(input.targetUserId);
      if (!account) throw new AdminRepositoryError("not_found");
      const operation = passwordOperations.get(input.targetUserId);
      if (!operation || operation.token !== input.operationToken) {
        return { applied: false };
      }
      if (!input.succeeded) account.mustChangePassword = operation.previousValue;
      passwordOperations.delete(input.targetUserId);
      return { applied: true };
    },
  };

  return {
    auth,
    authUsers,
    callerAuthorization,
    createInputs,
    deletedIds,
    events,
    repository,
    staff,
    updateInputs,
    service: createMentorAdminService({
      auth,
      repository,
      allowTrustedBootstrap: options.allowTrustedBootstrap ?? false,
      createOperationToken: nextOperationToken,
    }),
  };
}

describe("mentor account administration service", () => {
  test.each([
    [
      { isActive: false, mustChangePassword: false, roles: ["mentor", "team_admin"] as const },
      "inactive",
    ],
    [
      { isActive: true, mustChangePassword: true, roles: ["mentor", "team_admin"] as const },
      "password-change",
    ],
    [{ isActive: true, mustChangePassword: false, roles: ["mentor"] as const }, "role"],
  ])("rejects a caller that fails the %s authorization gate", async (caller, _gate) => {
    const harness = createHarness({ caller: { ...caller, roles: [...caller.roles] } });

    await expect(harness.service.listMentors({ actor: staffActor })).rejects.toMatchObject({
      code: "MENTOR_ADMIN_FORBIDDEN",
      message: "无权管理导师账号",
    });
    expect(harness.events).toEqual([]);
  });

  test("does not allow trusted-bootstrap mode unless the factory explicitly enables it", async () => {
    const harness = createHarness();

    await expect(harness.service.listMentors({ actor: bootstrapActor })).rejects.toMatchObject({
      code: "MENTOR_ADMIN_FORBIDDEN",
    });
  });

  test("normalizes a username and creates only trusted Auth metadata plus mentor mapping", async () => {
    const harness = createHarness();

    const result = await harness.service.createMentor({
      actor: staffActor,
      username: "  Mentor.New  ",
      temporaryPassword: fixturePassword,
      isTeamAdmin: false,
    });

    expect(result).toMatchObject({
      username: "mentor.new",
      isActive: true,
      mustChangePassword: true,
      roles: ["mentor"],
    });
    expect(harness.createInputs).toEqual([
      {
        email: mentorUsernameToEmail("mentor.new"),
        password: fixturePassword,
        emailConfirm: true,
        userMetadata: { username: "mentor.new" },
        appMetadata: {
          account_kind: "staff",
          staff_username: "mentor.new",
          auth_identity_version: 1,
        },
      },
    ]);
    expect(harness.events).toEqual(["auth:create", "db:provision"]);
    expect(JSON.stringify(result)).not.toContain(fixturePassword);
    expect(JSON.stringify(result)).not.toContain(mentorUsernameToEmail("mentor.new"));
    expect(JSON.stringify(result)).not.toContain('"email"');
  });

  test("assigns the optional team-admin role only through the provision mapping", async () => {
    const harness = createHarness();

    const result = await harness.service.createMentor({
      actor: staffActor,
      username: "mentor.admin",
      temporaryPassword: fixturePassword,
      isTeamAdmin: true,
    });

    expect(result.roles).toEqual(["mentor", "team_admin"]);
    expect(harness.createInputs[0]?.appMetadata).not.toHaveProperty("role");
    expect(harness.staff.get(result.userId)?.roles).toEqual(["mentor", "team_admin"]);
  });

  test("rejects an existing username before creating an Auth identity", async () => {
    const harness = createHarness({
      staff: [staffRecord({ username: "existing.fixture" })],
    });

    await expect(
      harness.service.createMentor({
        actor: staffActor,
        username: "EXISTING.FIXTURE",
        temporaryPassword: fixturePassword,
        isTeamAdmin: false,
      }),
    ).rejects.toMatchObject({ code: "MENTOR_USERNAME_CONFLICT", message: "用户名已存在" });
    expect(harness.createInputs).toEqual([]);
  });

  test("maps an Auth identity race to the same stable conflict", async () => {
    const harness = createHarness();
    harness.auth.createUser = async () => {
      throw new AdminAuthGatewayError("identity_conflict");
    };

    await expect(
      harness.service.createMentor({
        actor: staffActor,
        username: "raced.fixture",
        temporaryPassword: fixturePassword,
        isTeamAdmin: false,
      }),
    ).rejects.toMatchObject({ code: "MENTOR_USERNAME_CONFLICT", message: "用户名已存在" });
  });

  test("does not misclassify an unrelated Auth validation error as a username conflict", async () => {
    expect(classifyAuthAdminError({ status: 422, code: "weak_password" }).kind).toBe("unavailable");
  });

  test("deletes a new Auth identity when a database provision race loses", async () => {
    const harness = createHarness();
    harness.repository.provisionStaffAccount = async () => {
      harness.events.push("db:provision-conflict");
      throw new AdminRepositoryError("username_conflict");
    };

    await expect(
      harness.service.createMentor({
        actor: staffActor,
        username: "raced.fixture",
        temporaryPassword: fixturePassword,
        isTeamAdmin: false,
      }),
    ).rejects.toMatchObject({ code: "MENTOR_USERNAME_CONFLICT", message: "用户名已存在" });
    expect(harness.events).toEqual(["auth:create", "db:provision-conflict", "auth:delete"]);
    expect(harness.deletedIds).toHaveLength(1);
  });

  test("compensates any database provision failure without leaking the upstream error", async () => {
    const harness = createHarness();
    harness.repository.provisionStaffAccount = async () => {
      throw new Error(
        `upstream contained ${fixturePassword} and ${mentorUsernameToEmail("failed.fixture")}`,
      );
    };

    const operation = harness.service.createMentor({
      actor: staffActor,
      username: "failed.fixture",
      temporaryPassword: fixturePassword,
      isTeamAdmin: false,
    });

    await expect(operation).rejects.toMatchObject({
      code: "MENTOR_CREATE_FAILED",
      message: "导师账号创建失败",
    });
    await expect(operation).rejects.not.toThrow(fixturePassword);
    await expect(operation).rejects.not.toThrow(mentorUsernameToEmail("failed.fixture"));
    expect(harness.deletedIds).toHaveLength(1);
  });

  test("rejects and deletes an Auth identity if the actor becomes inactive before provision", async () => {
    const harness = createHarness();
    const authStarted = deferred();
    const releaseAuth = deferred();
    const originalCreate = harness.auth.createUser.bind(harness.auth);
    harness.auth.createUser = async (input) => {
      authStarted.resolve();
      await releaseAuth.promise;
      return originalCreate(input);
    };

    const operation = harness.service.createMentor({
      actor: staffActor,
      username: "authorization.race",
      temporaryPassword: fixturePassword,
      isTeamAdmin: false,
    });
    await authStarted.promise;
    harness.callerAuthorization.isActive = false;
    releaseAuth.resolve();

    await expect(operation).rejects.toMatchObject({
      code: "MENTOR_ADMIN_FORBIDDEN",
      message: "无权管理导师账号",
    });
    expect(harness.events).toEqual(["auth:create", "db:provision", "auth:delete"]);
    expect(harness.deletedIds).toHaveLength(1);
    expect([...harness.staff.values()].map(({ username }) => username)).not.toContain(
      "authorization.race",
    );
  });

  test("bans and safely logs a residual Auth identity if delete compensation fails", async () => {
    const harness = createHarness();
    const operationalLog = vi.spyOn(console, "error").mockImplementation(() => {});
    harness.repository.provisionStaffAccount = async () => {
      throw new Error(`database unavailable ${fixturePassword}`);
    };
    harness.auth.deleteUser = async () => {
      throw new Error(
        `delete failed for ${fixturePassword} ${mentorUsernameToEmail("failed.fixture")}`,
      );
    };

    try {
      await expect(
        harness.service.createMentor({
          actor: staffActor,
          username: "failed.fixture",
          temporaryPassword: fixturePassword,
          isTeamAdmin: false,
        }),
      ).rejects.toMatchObject({
        code: "MENTOR_CREATE_ROLLBACK_FAILED",
        message: "导师账号创建未完成，账号已保持不可用，请联系系统管理员",
        details: {
          containment: "banned",
          userId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
        },
      });
      expect(harness.updateInputs).toEqual([
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
          input: { banDuration: "876000h" },
        },
      ]);
      expect(operationalLog).toHaveBeenCalledWith("[MentorAdmin]", {
        code: "auth_identity_delete_failed",
        containment: "banned",
        event: "mentor_create_compensation_incomplete",
        userId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      });
      const serializedLog = JSON.stringify(operationalLog.mock.calls);
      expect(serializedLog).not.toContain(fixturePassword);
      expect(serializedLog).not.toContain(mentorUsernameToEmail("failed.fixture"));
    } finally {
      operationalLog.mockRestore();
    }
  });

  test("disables database access before banning Auth and stays closed on an Auth failure", async () => {
    const harness = createHarness({
      staff: [staffRecord({ userId: targetId, username: "disabled.fixture" })],
    });
    harness.auth.updateUser = async () => {
      harness.events.push("auth:ban-failed");
      throw new Error("auth unavailable");
    };

    await expect(
      harness.service.setMentorActive({
        actor: staffActor,
        targetUserId: targetId,
        isActive: false,
      }),
    ).rejects.toMatchObject({
      code: "MENTOR_DISABLE_PARTIAL",
      message: "账号已停用，但登录封禁同步失败，请稍后重试",
    });
    expect(harness.events).toEqual([
      "db:begin-disable",
      "db:active-state",
      "auth:ban-failed",
      "db:active-state",
    ]);
    expect(harness.staff.get(targetId)?.isActive).toBe(false);
  });

  test("uses the installed long ban duration when disabling", async () => {
    const harness = createHarness({
      staff: [staffRecord({ userId: targetId, username: "disabled.fixture" })],
    });

    await harness.service.setMentorActive({
      actor: staffActor,
      targetUserId: targetId,
      isActive: false,
    });

    expect(harness.updateInputs).toEqual([{ id: targetId, input: { banDuration: "876000h" } }]);
  });

  test("unbans before enabling and re-bans if the database activation fails", async () => {
    const harness = createHarness({
      staff: [
        staffRecord({
          userId: targetId,
          username: "disabled.fixture",
          isActive: false,
          disabledAt: "2026-07-22T08:00:00.000Z",
        }),
      ],
    });
    harness.repository.confirmStaffActiveSync = async () => {
      harness.events.push("db:active-confirm-failed");
      throw new Error("database unavailable");
    };

    await expect(
      harness.service.setMentorActive({
        actor: staffActor,
        targetUserId: targetId,
        isActive: true,
      }),
    ).rejects.toMatchObject({
      code: "MENTOR_ENABLE_FAILED",
      message: "账号启用失败，已保持停用状态",
    });
    expect(harness.events).toEqual([
      "db:begin-enable",
      "db:active-state",
      "auth:unban",
      "db:active-confirm-failed",
      "db:active-state",
      "auth:ban",
    ]);
    expect(harness.updateInputs.map(({ input }) => input)).toEqual([
      { banDuration: "none" },
      { banDuration: "876000h" },
    ]);
  });

  test("prevents disabling oneself before any state mutation", async () => {
    const harness = createHarness();

    await expect(
      harness.service.setMentorActive({
        actor: staffActor,
        targetUserId: callerId,
        isActive: false,
      }),
    ).rejects.toMatchObject({
      code: "MENTOR_SELF_DISABLE_FORBIDDEN",
      message: "不能停用自己的账号",
    });
    expect(harness.events).toEqual([]);
  });

  test("maps the repository last-admin invariant to a stable safe error", async () => {
    const harness = createHarness({
      staff: [
        staffRecord({
          userId: targetId,
          username: "last.admin",
          roles: ["mentor", "team_admin"],
        }),
      ],
    });
    harness.repository.beginStaffActiveOperation = async () => {
      throw new AdminRepositoryError("last_active_team_admin");
    };

    await expect(
      harness.service.setMentorActive({
        actor: staffActor,
        targetUserId: targetId,
        isActive: false,
      }),
    ).rejects.toMatchObject({
      code: "MENTOR_LAST_ADMIN_FORBIDDEN",
      message: "必须保留至少一个可用的团队管理员",
    });
  });

  test("rejects resetting the caller's own temporary password before DB or Auth mutation", async () => {
    const harness = createHarness();

    await expect(
      harness.service.resetTemporaryPassword({
        actor: staffActor,
        targetUserId: callerId,
        temporaryPassword: fixturePassword,
      }),
    ).rejects.toMatchObject({
      code: "MENTOR_SELF_PASSWORD_RESET_FORBIDDEN",
      message: "不能重置自己的临时密码",
    });
    expect(harness.events).toEqual([]);
    expect(harness.updateInputs).toEqual([]);
    expect(harness.staff.get(callerId)?.mustChangePassword).toBe(false);
  });

  test("maps the last-admin password-reset invariant to the stable safe error", async () => {
    const harness = createHarness();
    harness.repository.beginPasswordReset = async () => {
      throw new AdminRepositoryError("last_active_team_admin");
    };

    await expect(
      harness.service.resetTemporaryPassword({
        actor: staffActor,
        targetUserId: targetId,
        temporaryPassword: fixturePassword,
      }),
    ).rejects.toMatchObject({
      code: "MENTOR_LAST_ADMIN_FORBIDDEN",
      message: "必须保留至少一个可用的团队管理员",
    });
    expect(harness.updateInputs).toEqual([]);
  });

  test("forces must-change before resetting Auth and restores the previous flag on failure", async () => {
    const harness = createHarness({
      staff: [staffRecord({ userId: targetId, mustChangePassword: false })],
    });
    harness.auth.updateUser = async () => {
      harness.events.push("auth:password-failed");
      throw new Error(`unsafe ${fixturePassword}`);
    };

    await expect(
      harness.service.resetTemporaryPassword({
        actor: staffActor,
        targetUserId: targetId,
        temporaryPassword: fixturePassword,
      }),
    ).rejects.toMatchObject({
      code: "MENTOR_PASSWORD_RESET_FAILED",
      message: "临时密码重置失败，账号状态已安全恢复",
    });
    expect(harness.events).toEqual([
      "db:begin-password-reset",
      "auth:password-failed",
      "db:compensate-password-reset",
    ]);
    expect(harness.staff.get(targetId)?.mustChangePassword).toBe(false);
  });

  test("leaves must-change enabled if safe restoration races or fails", async () => {
    const harness = createHarness({
      staff: [staffRecord({ userId: targetId, mustChangePassword: false })],
    });
    harness.auth.updateUser = async () => {
      throw new Error("auth unavailable");
    };
    const originalFinish = harness.repository.finishPasswordReset.bind(harness.repository);
    harness.repository.finishPasswordReset = async (input) => {
      if (!input.succeeded) throw new AdminRepositoryError("concurrent_state");
      return originalFinish(input);
    };

    await expect(
      harness.service.resetTemporaryPassword({
        actor: staffActor,
        targetUserId: targetId,
        temporaryPassword: fixturePassword,
      }),
    ).rejects.toMatchObject({
      code: "MENTOR_PASSWORD_RESET_SAFE_FAILURE",
      message: "临时密码重置失败，账号已保持受限，请稍后重试",
    });
    expect(harness.staff.get(targetId)?.mustChangePassword).toBe(true);
  });

  test("never lets an older failed reset clear a newer successful reset gate", async () => {
    const harness = createHarness({
      staff: [staffRecord({ userId: targetId, mustChangePassword: false })],
    });
    const olderPassword = ["older", "fixture", "8!"].join("-");
    const newerPassword = ["newer", "fixture", "8!"].join("-");
    const olderAuthStarted = deferred();
    const rejectOlderAuth = deferred();

    harness.auth.updateUser = async (_id, input) => {
      if (input.password === olderPassword) {
        olderAuthStarted.resolve();
        await rejectOlderAuth.promise;
      }
      harness.events.push(`auth:password:${input.password === newerPassword ? "newer" : "older"}`);
    };

    const olderReset = harness.service.resetTemporaryPassword({
      actor: staffActor,
      targetUserId: targetId,
      temporaryPassword: olderPassword,
    });
    await olderAuthStarted.promise;

    await harness.service.resetTemporaryPassword({
      actor: staffActor,
      targetUserId: targetId,
      temporaryPassword: newerPassword,
    });
    expect(harness.staff.get(targetId)?.mustChangePassword).toBe(true);

    rejectOlderAuth.reject(new Error("older Auth update failed"));
    await expect(olderReset).rejects.toMatchObject({
      code: "MENTOR_PASSWORD_RESET_SAFE_FAILURE",
    });
    expect(harness.staff.get(targetId)?.mustChangePassword).toBe(true);
  });

  test("does not report success when a newer reset owns the password gate", async () => {
    const harness = createHarness({
      staff: [staffRecord({ userId: targetId, mustChangePassword: false })],
    });
    const olderPassword = ["older", "success", "8!"].join("-");
    const newerPassword = ["newer", "pending", "8!"].join("-");
    const olderAuthStarted = deferred();
    const newerAuthStarted = deferred();
    const releaseOlderAuth = deferred();
    const releaseNewerAuth = deferred();

    harness.auth.updateUser = async (_id, input) => {
      if (input.password === olderPassword) {
        olderAuthStarted.resolve();
        await releaseOlderAuth.promise;
      } else {
        newerAuthStarted.resolve();
        await releaseNewerAuth.promise;
      }
    };

    const olderReset = harness.service.resetTemporaryPassword({
      actor: staffActor,
      targetUserId: targetId,
      temporaryPassword: olderPassword,
    });
    await olderAuthStarted.promise;
    const newerReset = harness.service.resetTemporaryPassword({
      actor: staffActor,
      targetUserId: targetId,
      temporaryPassword: newerPassword,
    });
    await newerAuthStarted.promise;

    releaseOlderAuth.resolve();
    await expect(olderReset).rejects.toMatchObject({
      code: "MENTOR_PASSWORD_RESET_SAFE_FAILURE",
    });

    releaseNewerAuth.resolve();
    await expect(newerReset).resolves.toEqual({ ok: true });
    expect(harness.staff.get(targetId)?.mustChangePassword).toBe(true);
  });

  test("never returns the submitted temporary password from a successful reset", async () => {
    const harness = createHarness({
      staff: [staffRecord({ userId: targetId, mustChangePassword: false })],
    });

    const result = await harness.service.resetTemporaryPassword({
      actor: staffActor,
      targetUserId: targetId,
      temporaryPassword: fixturePassword,
    });

    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain(fixturePassword);
    expect(harness.updateInputs).toEqual([{ id: targetId, input: { password: fixturePassword } }]);
  });

  test("reconciles a stale disable after a newer enable so DB and Auth finish active", async () => {
    const harness = createHarness({
      staff: [
        staffRecord({
          userId: targetId,
          username: "concurrent.fixture",
          isActive: true,
        }),
      ],
    });
    const olderBanStarted = deferred();
    const releaseOlderBan = deferred();
    let authActive = true;
    let banCalls = 0;

    harness.auth.updateUser = async (_id, input) => {
      if (input.banDuration === "876000h") {
        banCalls += 1;
        if (banCalls === 1) {
          olderBanStarted.resolve();
          await releaseOlderBan.promise;
        }
        authActive = false;
        return;
      }
      if (input.banDuration === "none") {
        authActive = true;
      }
    };

    const olderDisable = harness.service.setMentorActive({
      actor: staffActor,
      targetUserId: targetId,
      isActive: false,
    });
    await olderBanStarted.promise;

    await harness.service.setMentorActive({
      actor: staffActor,
      targetUserId: targetId,
      isActive: true,
    });
    releaseOlderBan.resolve();
    await olderDisable.catch(() => {});

    expect(harness.staff.get(targetId)?.isActive).toBe(true);
    expect(authActive).toBe(true);
  });

  test("iterates Auth pages and joins only safe listing fields by user id", async () => {
    const harness = createHarness({
      staff: [
        staffRecord({ userId: targetId, username: "mentor.one" }),
        staffRecord({
          userId: secondTargetId,
          username: "mentor.two",
          isActive: false,
          mustChangePassword: true,
          disabledAt: "2026-07-21T08:00:00.000Z",
          roles: ["mentor", "team_admin"],
        }),
      ],
    });
    const internalEmail = mentorUsernameToEmail("mentor.one");
    harness.auth.listUsers = async ({ page }) => {
      harness.events.push(`auth:list:${page}`);
      return page === 1
        ? {
            users: [
              {
                id: targetId,
                lastSignInAt: "2026-07-22T09:30:00.000Z",
                bannedUntil: null,
                appMetadata: {
                  account_kind: "staff",
                  staff_username: "mentor.one",
                  auth_identity_version: 1,
                  opaque_internal_email_for_test: internalEmail,
                },
              },
            ],
            nextPage: 2,
          }
        : {
            users: [
              {
                id: secondTargetId,
                lastSignInAt: null,
                bannedUntil: "2126-07-22T09:30:00.000Z",
                appMetadata: {
                  account_kind: "staff",
                  staff_username: "mentor.two",
                  auth_identity_version: 1,
                },
              },
            ],
            nextPage: null,
          };
    };

    const result = await harness.service.listMentors({ actor: staffActor });

    expect(harness.events).toEqual(["db:list", "auth:list:1", "auth:list:2"]);
    expect(result).toEqual([
      {
        userId: targetId,
        username: "mentor.one",
        active: true,
        mustChangePassword: false,
        lastLoginAt: "2026-07-22T09:30:00.000Z",
        roles: ["mentor"],
        createdAt: "2026-07-20T08:00:00.000Z",
        disabledAt: null,
      },
      {
        userId: secondTargetId,
        username: "mentor.two",
        active: false,
        mustChangePassword: true,
        lastLoginAt: null,
        roles: ["mentor", "team_admin"],
        createdAt: "2026-07-20T08:00:00.000Z",
        disabledAt: "2026-07-21T08:00:00.000Z",
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(internalEmail);
    expect(serialized).not.toContain("appMetadata");
    expect(serialized).not.toContain("bannedUntil");
    expect(serialized).not.toContain('"password"');
  });
});

describe("mentor administration delivery contracts", () => {
  const functionsPath = resolve(process.cwd(), "src/lib/auth/admin.functions.ts");
  const adminServerPath = resolve(process.cwd(), "src/lib/auth/admin.server.ts");
  const routePath = resolve(process.cwd(), "src/routes/_authenticated/admin.mentors.tsx");
  const mentorDeskPath = resolve(process.cwd(), "src/routes/_authenticated/index.tsx");
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/20260723090200_mentor_account_admin.sql",
  );
  const typesPath = resolve(process.cwd(), "src/integrations/supabase/types.ts");
  const pgTapPath = resolve(process.cwd(), "supabase/tests/cloud_integration_test.sql");

  test("exposes thin authenticated server functions with validated password-free results", () => {
    expect(existsSync(functionsPath)).toBe(true);
    const source = readFileSync(functionsPath, "utf8");

    expect(source.match(/createServerFn\(\{\s*method:\s*"GET"\s*\}\)/g)).toHaveLength(1);
    expect(source.match(/createServerFn\(\{\s*method:\s*"POST"\s*\}\)/g)).toHaveLength(3);
    expect(source.match(/\.middleware\(\[requireSupabaseAuth\]\)/g)).toHaveLength(4);
    expect(source.match(/context\.userId/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source).toContain('await import("./admin.server")');
    expect(source).toContain("z.string().uuid()");
    expect(source.match(/temporaryPassword:\s*z\.string\(\)\.min\(8\)\.max\(256\)/g)).toHaveLength(
      2,
    );
    expect(source).not.toContain("client.server");
    expect(source).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  test("provides an admin-only UI that clears password state after submissions", () => {
    expect(existsSync(routePath)).toBe(true);
    const source = readFileSync(routePath, "utf8");

    expect(source).toContain('createFileRoute("/_authenticated/admin/mentors")');
    expect(source).toContain("listMentors");
    expect(source).toContain("createMentorAccount");
    expect(source).toContain("setMentorAccountActive");
    expect(source).toContain("resetMentorAccountPassword");
    expect(source).toMatch(/setCreatePassword\(\s*""\s*\)/);
    expect(source).toMatch(
      /setResetPasswords\(\(current\)\s*=>\s*\(\{\s*\.\.\.current,\s*\[account\.userId\]:\s*""/,
    );
    expect(source).toContain("window.confirm");
    expect(source).toMatch(
      /isSelf\s*\?\s*\([\s\S]*?当前账号请通过修改密码流程更新密码，不能在此重置临时密码[\s\S]*?\)\s*:\s*\(\s*<form/,
    );
    expect(source).not.toContain("admin.server");
    expect(source).not.toContain("client.server");
  });

  test("shows the mentor-account link only when the signed-in staff has team-admin", () => {
    const source = readFileSync(mentorDeskPath, "utf8");

    expect(source).toContain("isTeamAdmin");
    expect(source).toContain('accountRole === "team_admin"');
    expect(source).toContain('to="/admin/mentors"');
    expect(source).toMatch(/\{\s*isTeamAdmin\s*&&\s*\(/);
  });

  test("defines service-role-only atomic state and reset RPCs", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const source = readFileSync(migrationPath, "utf8");

    for (const column of [
      "password_reset_operation_token uuid",
      "password_reset_previous_must_change boolean",
      "active_operation_token uuid",
      "active_operation_desired boolean",
      "active_state_version bigint NOT NULL DEFAULT 0",
    ]) {
      expect(source).toMatch(new RegExp(column.replaceAll(" ", "\\s+"), "i"));
    }

    for (const functionName of [
      "admin_begin_staff_password_reset",
      "admin_finish_staff_password_reset",
      "admin_begin_staff_active_operation",
      "admin_get_staff_active_sync_state",
      "admin_confirm_staff_active_sync",
    ]) {
      expect(source).toMatch(
        new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${functionName}`, "i"),
      );
      expect(source).toMatch(
        new RegExp(
          `REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${functionName}\\s*\\([^;]+\\)\\s+FROM\\s+PUBLIC\\s*,\\s*anon\\s*,\\s*authenticated`,
          "i",
        ),
      );
      expect(source).toMatch(
        new RegExp(
          `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${functionName}\\s*\\([^;]+\\)\\s+TO\\s+service_role`,
          "i",
        ),
      );
    }

    expect(source).toMatch(/pg_advisory_xact_lock/i);
    expect(source).toMatch(/staff_self_disable_forbidden/i);
    expect(source).toMatch(/staff_self_password_reset_forbidden/i);
    expect(source).toMatch(/last_active_team_admin_required/i);
    expect(source).toMatch(
      /must_change_password\s*=\s*false[\s\S]*?'team_admin'::public\.app_role/i,
    );
    expect(source).toMatch(/disabled_at\s*=\s*CASE/i);
    expect(source).toMatch(/disabled_by\s*=\s*CASE/i);
    expect(source).toMatch(/password_reset_operation_token\s*=\s*_operation_token/i);
    expect(source).toMatch(
      /password_reset_operation_token\s+IS\s+DISTINCT\s+FROM\s+_operation_token[\s\S]*?'applied'\s*,\s*false/i,
    );
    expect(source).toMatch(/active_state_version\s*=\s*active_state_version\s*\+\s*1/i);
    expect(source).toMatch(
      /active_state_version\s*<>\s*_observed_version[\s\S]*?'confirmed'\s*,\s*false/i,
    );
    expect(source).not.toMatch(/\bTO\s+authenticated\b/i);

    const passwordReset = source.slice(
      source.indexOf("CREATE OR REPLACE FUNCTION public.admin_begin_staff_password_reset"),
      source.indexOf("REVOKE ALL ON FUNCTION public.admin_begin_staff_password_reset"),
    );
    expect(passwordReset).toMatch(
      /pg_advisory_xact_lock[\s\S]*?actor\.is_active\s*=\s*true[\s\S]*?actor\.must_change_password\s*=\s*false[\s\S]*?'team_admin'::public\.app_role/i,
    );
    expect(passwordReset).toMatch(
      /count\(\*\)[\s\S]*?must_change_password\s*=\s*false[\s\S]*?'team_admin'::public\.app_role[\s\S]*?last_active_team_admin_required/i,
    );
  });

  test("keeps generated types and pgTAP aligned with versioned admin operations", () => {
    const types = readFileSync(typesPath, "utf8");
    const pgTap = readFileSync(pgTapPath, "utf8");

    for (const field of [
      "password_reset_operation_token",
      "password_reset_previous_must_change",
      "active_operation_token",
      "active_operation_desired",
      "active_state_version",
    ]) {
      expect(types).toContain(`${field}:`);
    }
    for (const functionName of [
      "admin_begin_staff_password_reset",
      "admin_finish_staff_password_reset",
      "admin_begin_staff_active_operation",
      "admin_get_staff_active_sync_state",
      "admin_confirm_staff_active_sync",
    ]) {
      expect(types).toContain(`${functionName}:`);
      expect(pgTap).toContain(functionName);
    }
    expect(pgTap).toMatch(/staff_self_disable_forbidden/i);
    expect(pgTap).toMatch(
      /admin_begin_staff_password_reset\s*\(\s*'10000000-0000-0000-0000-000000000101'::uuid\s*,\s*'10000000-0000-0000-0000-000000000101'::uuid[\s\S]*?staff_self_password_reset_forbidden/i,
    );
    expect(pgTap).toMatch(/mutual admin reset keeps one usable team admin/i);
    expect(pgTap).toMatch(/reset then disable interleaving keeps one usable team admin/i);
    expect(pgTap).toMatch(
      /admin_begin_staff_active_operation\s*\(\s*'10000000-0000-0000-0000-000000000103'::uuid\s*,\s*'10000000-0000-0000-0000-000000000101'::uuid[\s\S]*?last_active_team_admin_required/i,
    );
    expect(pgTap).not.toMatch(/--[^\n]*last_active_team_admin_required invariant/i);

    const adminServer = readFileSync(adminServerPath, "utf8");
    expect(adminServer).toContain("bootstrapStaffAccount");
    expect(adminServer).toMatch(
      /if\s*\(\s*input\.actor\.kind\s*===\s*"trusted_bootstrap"\s*\)[\s\S]*?bootstrapStaffAccount[\s\S]*?else[\s\S]*?provisionStaffAccount/,
    );
    expect(adminServer).not.toMatch(/createdBy\s*===\s*null/);
  });
});
