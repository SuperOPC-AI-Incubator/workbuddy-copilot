import { randomUUID } from "node:crypto";

import type { Json } from "@/integrations/supabase/types";
import { mentorUsernameToEmail, normalizeMentorUsername } from "@/lib/auth/identifiers";

export type MentorAdminRole = "mentor" | "team_admin";

export type MentorAdminActor = { kind: "staff"; userId: string } | { kind: "trusted_bootstrap" };

export type CallerAuthorization = {
  isActive: boolean;
  mustChangePassword: boolean;
  roles: MentorAdminRole[];
};

export type StaffAccountRecord = {
  userId: string;
  username: string;
  isActive: boolean;
  mustChangePassword: boolean;
  roles: MentorAdminRole[];
  createdAt: string;
  disabledAt: string | null;
};

export type MentorAccountDto = {
  userId: string;
  username: string;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  roles: MentorAdminRole[];
  createdAt: string;
  disabledAt: string | null;
};

export type CreatedMentorAccount = Omit<MentorAccountDto, "active" | "lastLoginAt"> & {
  isActive: boolean;
};

export type AdminAuthUser = {
  id: string;
  lastSignInAt: string | null;
  bannedUntil: string | null;
  appMetadata: Record<string, unknown>;
};

export interface AdminAuthGateway {
  createUser(input: {
    email: string;
    password: string;
    userMetadata: { username: string };
    appMetadata: {
      account_kind: "staff";
      staff_username: string;
      auth_identity_version: 1;
    };
    emailConfirm: true;
  }): Promise<string>;
  updateUser(
    id: string,
    input: {
      password?: string;
      banDuration?: string | "none";
    },
  ): Promise<void>;
  deleteUser(id: string): Promise<void>;
  listUsers(input: {
    page: number;
    perPage: number;
  }): Promise<{ users: AdminAuthUser[]; nextPage: number | null }>;
}

export interface MentorAdminRepository {
  getCallerAuthorization(userId: string): Promise<CallerAuthorization | null>;
  findStaffByUsername(username: string): Promise<StaffAccountRecord | null>;
  listStaffAccounts(): Promise<StaffAccountRecord[]>;
  provisionStaffAccount(input: {
    userId: string;
    username: string;
    createdBy: string;
    isTeamAdmin: boolean;
  }): Promise<void>;
  bootstrapStaffAccount(input: {
    userId: string;
    username: string;
    isTeamAdmin: boolean;
  }): Promise<void>;
  beginStaffActiveOperation(input: {
    actorUserId: string;
    targetUserId: string;
    isActive: boolean;
    operationToken: string;
  }): Promise<void>;
  getStaffActiveSyncState(input: { actorUserId: string; targetUserId: string }): Promise<{
    version: number;
    operationToken: string | null;
    desiredActive: boolean;
  }>;
  confirmStaffActiveSync(input: {
    actorUserId: string;
    targetUserId: string;
    observedVersion: number;
    operationToken: string | null;
  }): Promise<{ confirmed: boolean; active: boolean }>;
  beginPasswordReset(input: {
    actorUserId: string;
    targetUserId: string;
    operationToken: string;
  }): Promise<{ previousValue: boolean }>;
  finishPasswordReset(input: {
    actorUserId: string;
    targetUserId: string;
    operationToken: string;
    succeeded: boolean;
  }): Promise<{ applied: boolean }>;
}

export type AdminAuthGatewayErrorKind = "identity_conflict" | "unavailable";

export class AdminAuthGatewayError extends Error {
  readonly kind: AdminAuthGatewayErrorKind;

  constructor(kind: AdminAuthGatewayErrorKind) {
    super(kind);
    this.name = "AdminAuthGatewayError";
    this.kind = kind;
  }
}

export type AdminRepositoryErrorKind =
  | "username_conflict"
  | "self_disable"
  | "self_password_reset"
  | "last_active_team_admin"
  | "not_found"
  | "concurrent_state"
  | "forbidden"
  | "unavailable";

export class AdminRepositoryError extends Error {
  readonly kind: AdminRepositoryErrorKind;

  constructor(kind: AdminRepositoryErrorKind) {
    super(kind);
    this.name = "AdminRepositoryError";
    this.kind = kind;
  }
}

export type MentorAdminErrorCode =
  | "MENTOR_ADMIN_FORBIDDEN"
  | "MENTOR_USERNAME_CONFLICT"
  | "MENTOR_CREATE_FAILED"
  | "MENTOR_CREATE_ROLLBACK_FAILED"
  | "MENTOR_SELF_DISABLE_FORBIDDEN"
  | "MENTOR_SELF_PASSWORD_RESET_FORBIDDEN"
  | "MENTOR_LAST_ADMIN_FORBIDDEN"
  | "MENTOR_NOT_FOUND"
  | "MENTOR_DISABLE_FAILED"
  | "MENTOR_DISABLE_PARTIAL"
  | "MENTOR_ENABLE_FAILED"
  | "MENTOR_STATE_SUPERSEDED"
  | "MENTOR_PASSWORD_RESET_FAILED"
  | "MENTOR_PASSWORD_RESET_SAFE_FAILURE"
  | "MENTOR_LIST_FAILED";

export class MentorAdminError extends Error {
  readonly code: MentorAdminErrorCode;
  readonly details?: {
    containment: "banned" | "ban_failed";
    userId: string;
  };

  constructor(code: MentorAdminErrorCode, message: string, details?: MentorAdminError["details"]) {
    super(message);
    this.name = "MentorAdminError";
    this.code = code;
    this.details = details;
  }
}

export const AUTH_DISABLE_BAN_DURATION = "876000h";
export const AUTH_ENABLE_BAN_DURATION = "none";
const AUTH_LIST_PAGE_SIZE = 200;
const ACTIVE_SYNC_ATTEMPTS = 8;

type MentorAdminOperationalEvent = {
  code: "auth_identity_delete_failed";
  containment: "banned" | "ban_failed";
  event: "mentor_create_compensation_incomplete";
  userId: string;
};

const defaultOperationalLogger = {
  error(event: MentorAdminOperationalEvent) {
    console.error("[MentorAdmin]", event);
  },
};

function adminError(
  code: MentorAdminErrorCode,
  message: string,
  details?: MentorAdminError["details"],
): MentorAdminError {
  return new MentorAdminError(code, message, details);
}

function mapRepositoryMutationError(error: unknown): MentorAdminError {
  if (error instanceof AdminRepositoryError) {
    if (error.kind === "self_disable") {
      return adminError("MENTOR_SELF_DISABLE_FORBIDDEN", "不能停用自己的账号");
    }
    if (error.kind === "last_active_team_admin") {
      return adminError("MENTOR_LAST_ADMIN_FORBIDDEN", "必须保留至少一个可用的团队管理员");
    }
    if (error.kind === "not_found") {
      return adminError("MENTOR_NOT_FOUND", "导师账号不存在");
    }
    if (error.kind === "forbidden") {
      return adminError("MENTOR_ADMIN_FORBIDDEN", "无权管理导师账号");
    }
  }

  return adminError("MENTOR_DISABLE_FAILED", "账号状态更新失败，请稍后重试");
}

function isTrustedStaffMetadata(user: AdminAuthUser, staff: StaffAccountRecord): boolean {
  return (
    user.appMetadata.account_kind === "staff" &&
    user.appMetadata.staff_username === staff.username &&
    user.appMetadata.auth_identity_version === 1
  );
}

export function createMentorAdminService({
  auth,
  repository,
  allowTrustedBootstrap = false,
  createOperationToken = randomUUID,
  operationalLogger = defaultOperationalLogger,
}: {
  auth: AdminAuthGateway;
  repository: MentorAdminRepository;
  allowTrustedBootstrap?: boolean;
  createOperationToken?: () => string;
  operationalLogger?: { error(event: MentorAdminOperationalEvent): void };
}) {
  async function authorize(actor: MentorAdminActor): Promise<void> {
    if (actor.kind === "trusted_bootstrap") {
      if (allowTrustedBootstrap) return;
      throw adminError("MENTOR_ADMIN_FORBIDDEN", "无权管理导师账号");
    }

    let caller: CallerAuthorization | null;
    try {
      caller = await repository.getCallerAuthorization(actor.userId);
    } catch {
      throw adminError("MENTOR_ADMIN_FORBIDDEN", "无权管理导师账号");
    }

    if (!caller?.isActive || caller.mustChangePassword || !caller.roles.includes("team_admin")) {
      throw adminError("MENTOR_ADMIN_FORBIDDEN", "无权管理导师账号");
    }
  }

  async function listMentors({ actor }: { actor: MentorAdminActor }): Promise<MentorAccountDto[]> {
    await authorize(actor);

    let staffAccounts: StaffAccountRecord[];
    try {
      staffAccounts = await repository.listStaffAccounts();
    } catch {
      throw adminError("MENTOR_LIST_FAILED", "导师账号列表加载失败");
    }

    const authUsers = new Map<string, AdminAuthUser>();
    let page = 1;
    const visitedPages = new Set<number>();

    try {
      while (!visitedPages.has(page)) {
        visitedPages.add(page);
        const result = await auth.listUsers({ page, perPage: AUTH_LIST_PAGE_SIZE });
        for (const user of result.users) authUsers.set(user.id, user);
        if (result.nextPage === null) break;
        page = result.nextPage;
      }
    } catch {
      throw adminError("MENTOR_LIST_FAILED", "导师账号列表加载失败");
    }

    return staffAccounts
      .map((staff) => {
        const authUser = authUsers.get(staff.userId);
        return {
          userId: staff.userId,
          username: staff.username,
          active: staff.isActive,
          mustChangePassword: staff.mustChangePassword,
          lastLoginAt:
            authUser && isTrustedStaffMetadata(authUser, staff) ? authUser.lastSignInAt : null,
          roles: [...staff.roles],
          createdAt: staff.createdAt,
          disabledAt: staff.disabledAt,
        };
      })
      .sort((left, right) => left.username.localeCompare(right.username));
  }

  async function createMentor(input: {
    actor: MentorAdminActor;
    username: string;
    temporaryPassword: string;
    isTeamAdmin: boolean;
  }): Promise<CreatedMentorAccount> {
    await authorize(input.actor);
    const username = normalizeMentorUsername(input.username);

    let existing: StaffAccountRecord | null;
    try {
      existing = await repository.findStaffByUsername(username);
    } catch {
      throw adminError("MENTOR_CREATE_FAILED", "导师账号创建失败");
    }
    if (existing) {
      throw adminError("MENTOR_USERNAME_CONFLICT", "用户名已存在");
    }

    let userId: string;
    try {
      userId = await auth.createUser({
        email: mentorUsernameToEmail(username),
        password: input.temporaryPassword,
        emailConfirm: true,
        userMetadata: { username },
        appMetadata: {
          account_kind: "staff",
          staff_username: username,
          auth_identity_version: 1,
        },
      });
    } catch (error) {
      if (error instanceof AdminAuthGatewayError && error.kind === "identity_conflict") {
        throw adminError("MENTOR_USERNAME_CONFLICT", "用户名已存在");
      }
      throw adminError("MENTOR_CREATE_FAILED", "导师账号创建失败");
    }

    try {
      const provisionInput = {
        userId,
        username,
        isTeamAdmin: input.isTeamAdmin,
      };
      if (input.actor.kind === "trusted_bootstrap") {
        await repository.bootstrapStaffAccount(provisionInput);
      } else {
        await repository.provisionStaffAccount({
          ...provisionInput,
          createdBy: input.actor.userId,
        });
      }
    } catch (provisionError) {
      try {
        await auth.deleteUser(userId);
      } catch {
        let containment: "banned" | "ban_failed" = "ban_failed";
        try {
          await auth.updateUser(userId, {
            banDuration: AUTH_DISABLE_BAN_DURATION,
          });
          containment = "banned";
        } catch {
          // The operational event below makes a failed containment actionable.
        }
        operationalLogger.error({
          code: "auth_identity_delete_failed",
          containment,
          event: "mentor_create_compensation_incomplete",
          userId,
        });
        throw adminError(
          "MENTOR_CREATE_ROLLBACK_FAILED",
          "导师账号创建未完成，账号已保持不可用，请联系系统管理员",
          { containment, userId },
        );
      }

      if (
        provisionError instanceof AdminRepositoryError &&
        provisionError.kind === "username_conflict"
      ) {
        throw adminError("MENTOR_USERNAME_CONFLICT", "用户名已存在");
      }
      if (provisionError instanceof AdminRepositoryError && provisionError.kind === "forbidden") {
        throw adminError("MENTOR_ADMIN_FORBIDDEN", "无权管理导师账号");
      }
      throw adminError("MENTOR_CREATE_FAILED", "导师账号创建失败");
    }

    return {
      userId,
      username,
      isActive: true,
      mustChangePassword: true,
      roles: input.isTeamAdmin ? ["mentor", "team_admin"] : ["mentor"],
      createdAt: new Date().toISOString(),
      disabledAt: null,
    };
  }

  async function setMentorActive(input: {
    actor: MentorAdminActor;
    targetUserId: string;
    isActive: boolean;
  }): Promise<{ ok: true }> {
    await authorize(input.actor);
    if (input.actor.kind !== "staff") {
      throw adminError("MENTOR_ADMIN_FORBIDDEN", "无权管理导师账号");
    }
    const actorUserId = input.actor.userId;

    if (!input.isActive && actorUserId === input.targetUserId) {
      throw adminError("MENTOR_SELF_DISABLE_FORBIDDEN", "不能停用自己的账号");
    }

    try {
      await repository.beginStaffActiveOperation({
        actorUserId,
        targetUserId: input.targetUserId,
        isActive: input.isActive,
        operationToken: createOperationToken(),
      });
    } catch (error) {
      const mapped = mapRepositoryMutationError(error);
      if (input.isActive && mapped.code === "MENTOR_DISABLE_FAILED") {
        throw adminError("MENTOR_ENABLE_FAILED", "账号启用失败，已保持停用状态");
      }
      throw mapped;
    }

    for (let attempt = 0; attempt < ACTIVE_SYNC_ATTEMPTS; attempt += 1) {
      let state: Awaited<ReturnType<MentorAdminRepository["getStaffActiveSyncState"]>>;
      try {
        state = await repository.getStaffActiveSyncState({
          actorUserId,
          targetUserId: input.targetUserId,
        });
      } catch (error) {
        if (error instanceof AdminRepositoryError && error.kind === "not_found") {
          throw adminError("MENTOR_NOT_FOUND", "导师账号不存在");
        }
        throw adminError(
          input.isActive ? "MENTOR_ENABLE_FAILED" : "MENTOR_DISABLE_FAILED",
          input.isActive ? "账号启用失败，已保持停用状态" : "账号状态更新失败，请稍后重试",
        );
      }

      try {
        await auth.updateUser(input.targetUserId, {
          banDuration: state.desiredActive ? AUTH_ENABLE_BAN_DURATION : AUTH_DISABLE_BAN_DURATION,
        });
      } catch {
        try {
          const latest = await repository.getStaffActiveSyncState({
            actorUserId,
            targetUserId: input.targetUserId,
          });
          if (
            latest.version !== state.version ||
            latest.operationToken !== state.operationToken ||
            latest.desiredActive !== state.desiredActive
          ) {
            continue;
          }
        } catch {
          // Fall through to the fail-closed error for the observed state.
        }

        if (state.desiredActive) {
          try {
            await auth.updateUser(input.targetUserId, {
              banDuration: AUTH_DISABLE_BAN_DURATION,
            });
          } catch {
            // The database remains inactive until a confirmed enable.
          }
          throw adminError("MENTOR_ENABLE_FAILED", "账号启用失败，已保持停用状态");
        }
        throw adminError("MENTOR_DISABLE_PARTIAL", "账号已停用，但登录封禁同步失败，请稍后重试");
      }

      try {
        const confirmation = await repository.confirmStaffActiveSync({
          actorUserId,
          targetUserId: input.targetUserId,
          observedVersion: state.version,
          operationToken: state.operationToken,
        });
        if (!confirmation.confirmed) continue;
        if (confirmation.active !== input.isActive) {
          throw adminError("MENTOR_STATE_SUPERSEDED", "账号状态已被其他操作更新，请刷新后重试");
        }
        return { ok: true };
      } catch (error) {
        if (error instanceof MentorAdminError) throw error;
        try {
          const latest = await repository.getStaffActiveSyncState({
            actorUserId,
            targetUserId: input.targetUserId,
          });
          if (
            latest.version !== state.version ||
            latest.operationToken !== state.operationToken ||
            latest.desiredActive !== state.desiredActive
          ) {
            continue;
          }
        } catch {
          // The target was made inactive at begin; preserve that boundary.
        }
        try {
          await auth.updateUser(input.targetUserId, {
            banDuration: AUTH_DISABLE_BAN_DURATION,
          });
        } catch {
          // Database access is still inactive even if the Auth ban is uncertain.
        }
        throw adminError(
          state.desiredActive ? "MENTOR_ENABLE_FAILED" : "MENTOR_DISABLE_FAILED",
          state.desiredActive ? "账号启用失败，已保持停用状态" : "账号状态更新失败，请稍后重试",
        );
      }
    }

    throw adminError("MENTOR_STATE_SUPERSEDED", "账号状态并发更新过于频繁，请刷新后重试");
  }

  async function resetTemporaryPassword(input: {
    actor: MentorAdminActor;
    targetUserId: string;
    temporaryPassword: string;
  }): Promise<{ ok: true }> {
    await authorize(input.actor);
    if (input.actor.kind !== "staff") {
      throw adminError("MENTOR_ADMIN_FORBIDDEN", "无权管理导师账号");
    }
    const actorUserId = input.actor.userId;
    if (actorUserId === input.targetUserId) {
      throw adminError("MENTOR_SELF_PASSWORD_RESET_FORBIDDEN", "不能重置自己的临时密码");
    }

    const operationToken = createOperationToken();
    try {
      await repository.beginPasswordReset({
        actorUserId,
        targetUserId: input.targetUserId,
        operationToken,
      });
    } catch (error) {
      if (error instanceof AdminRepositoryError && error.kind === "not_found") {
        throw adminError("MENTOR_NOT_FOUND", "导师账号不存在");
      }
      if (error instanceof AdminRepositoryError && error.kind === "forbidden") {
        throw adminError("MENTOR_ADMIN_FORBIDDEN", "无权管理导师账号");
      }
      if (error instanceof AdminRepositoryError && error.kind === "self_password_reset") {
        throw adminError("MENTOR_SELF_PASSWORD_RESET_FORBIDDEN", "不能重置自己的临时密码");
      }
      if (error instanceof AdminRepositoryError && error.kind === "last_active_team_admin") {
        throw adminError("MENTOR_LAST_ADMIN_FORBIDDEN", "必须保留至少一个可用的团队管理员");
      }
      throw adminError(
        "MENTOR_PASSWORD_RESET_SAFE_FAILURE",
        "临时密码重置失败，账号已保持受限，请稍后重试",
      );
    }

    try {
      await auth.updateUser(input.targetUserId, {
        password: input.temporaryPassword,
      });
    } catch {
      try {
        const { applied } = await repository.finishPasswordReset({
          actorUserId,
          targetUserId: input.targetUserId,
          operationToken,
          succeeded: false,
        });
        if (applied) {
          throw adminError("MENTOR_PASSWORD_RESET_FAILED", "临时密码重置失败，账号状态已安全恢复");
        }
      } catch (error) {
        if (error instanceof MentorAdminError) throw error;
      }

      throw adminError(
        "MENTOR_PASSWORD_RESET_SAFE_FAILURE",
        "临时密码重置失败，账号已保持受限，请稍后重试",
      );
    }

    try {
      const { applied } = await repository.finishPasswordReset({
        actorUserId,
        targetUserId: input.targetUserId,
        operationToken,
        succeeded: true,
      });
      if (!applied) {
        throw adminError(
          "MENTOR_PASSWORD_RESET_SAFE_FAILURE",
          "临时密码已更新，但账号状态已被其他操作接管，请刷新确认",
        );
      }
    } catch {
      throw adminError(
        "MENTOR_PASSWORD_RESET_SAFE_FAILURE",
        "临时密码已更新，账号保持受限，请刷新确认状态",
      );
    }

    return { ok: true };
  }

  return {
    listMentors,
    createMentor,
    setMentorActive,
    resetTemporaryPassword,
  };
}

export function classifyAuthAdminError(error: unknown): AdminAuthGatewayError {
  const candidate = typeof error === "object" && error !== null ? (error as { code?: string }) : {};
  if (candidate.code === "email_exists" || candidate.code === "user_already_exists") {
    return new AdminAuthGatewayError("identity_conflict");
  }
  return new AdminAuthGatewayError("unavailable");
}

function repositoryError(error: unknown): AdminRepositoryError {
  const candidate =
    typeof error === "object" && error !== null
      ? (error as { code?: string; message?: string })
      : {};
  if (candidate.code === "23505") return new AdminRepositoryError("username_conflict");

  switch (candidate.message) {
    case "staff_self_disable_forbidden":
      return new AdminRepositoryError("self_disable");
    case "staff_self_password_reset_forbidden":
      return new AdminRepositoryError("self_password_reset");
    case "last_active_team_admin_required":
      return new AdminRepositoryError("last_active_team_admin");
    case "staff_account_not_found":
      return new AdminRepositoryError("not_found");
    case "staff_admin_forbidden":
      return new AdminRepositoryError("forbidden");
    case "staff_state_changed":
      return new AdminRepositoryError("concurrent_state");
    default:
      return new AdminRepositoryError("unavailable");
  }
}

function readBooleanResult(data: Json, key: string): boolean {
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    typeof data[key] !== "boolean"
  ) {
    throw new AdminRepositoryError("unavailable");
  }
  return data[key];
}

function readNumberResult(data: Json, key: string): number {
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    typeof data[key] !== "number"
  ) {
    throw new AdminRepositoryError("unavailable");
  }
  return data[key];
}

function readNullableStringResult(data: Json, key: string): string | null {
  if (
    typeof data !== "object" ||
    data === null ||
    Array.isArray(data) ||
    (data[key] !== null && typeof data[key] !== "string")
  ) {
    throw new AdminRepositoryError("unavailable");
  }
  return data[key];
}

export async function createProductionMentorAdminService(options?: {
  allowTrustedBootstrap?: boolean;
}) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const auth: AdminAuthGateway = {
    async createUser(input) {
      let response: Awaited<ReturnType<typeof supabaseAdmin.auth.admin.createUser>>;
      try {
        response = await supabaseAdmin.auth.admin.createUser({
          email: input.email,
          password: input.password,
          email_confirm: input.emailConfirm,
          user_metadata: input.userMetadata,
          app_metadata: input.appMetadata,
        });
      } catch (error) {
        throw classifyAuthAdminError(error);
      }
      if (response.error || !response.data.user) {
        throw classifyAuthAdminError(response.error);
      }
      return response.data.user.id;
    },
    async updateUser(id, input) {
      const { data, error } = await supabaseAdmin.auth.admin.updateUserById(id, {
        ...(input.password === undefined ? {} : { password: input.password }),
        ...(input.banDuration === undefined ? {} : { ban_duration: input.banDuration }),
      });
      if (error || !data.user) throw new AdminAuthGatewayError("unavailable");
    },
    async deleteUser(id) {
      const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
      if (error) throw new AdminAuthGatewayError("unavailable");
    },
    async listUsers({ page, perPage }) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage,
      });
      if (error) throw new AdminAuthGatewayError("unavailable");
      return {
        users: data.users.map((user) => ({
          id: user.id,
          lastSignInAt: user.last_sign_in_at ?? null,
          bannedUntil: user.banned_until ?? null,
          appMetadata: user.app_metadata,
        })),
        nextPage: data.nextPage,
      };
    },
  };

  const repository: MentorAdminRepository = {
    async getCallerAuthorization(userId) {
      const [{ data: staff, error: staffError }, { data: roleRows, error: rolesError }] =
        await Promise.all([
          supabaseAdmin
            .from("staff_accounts")
            .select("is_active, must_change_password")
            .eq("user_id", userId)
            .maybeSingle(),
          supabaseAdmin
            .from("user_roles")
            .select("role")
            .eq("user_id", userId)
            .in("role", ["mentor", "team_admin"]),
        ]);
      if (staffError || rolesError) throw new AdminRepositoryError("unavailable");
      if (!staff) return null;
      return {
        isActive: staff.is_active,
        mustChangePassword: staff.must_change_password,
        roles: roleRows.map(({ role }) => role as MentorAdminRole),
      };
    },
    async findStaffByUsername(username) {
      const { data, error } = await supabaseAdmin
        .from("staff_accounts")
        .select("user_id, username, is_active, must_change_password, created_at, disabled_at")
        .eq("normalized_username", username)
        .maybeSingle();
      if (error) throw new AdminRepositoryError("unavailable");
      if (!data) return null;
      const { data: roles, error: rolesError } = await supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", data.user_id)
        .in("role", ["mentor", "team_admin"]);
      if (rolesError) throw new AdminRepositoryError("unavailable");
      return {
        userId: data.user_id,
        username: data.username,
        isActive: data.is_active,
        mustChangePassword: data.must_change_password,
        roles: roles.map(({ role }) => role as MentorAdminRole),
        createdAt: data.created_at,
        disabledAt: data.disabled_at,
      };
    },
    async listStaffAccounts() {
      const records: Array<{
        user_id: string;
        username: string;
        is_active: boolean;
        must_change_password: boolean;
        created_at: string;
        disabled_at: string | null;
      }> = [];
      const pageSize = 500;

      for (let page = 0; ; page += 1) {
        const { data, error } = await supabaseAdmin
          .from("staff_accounts")
          .select("user_id, username, is_active, must_change_password, created_at, disabled_at")
          .order("username")
          .range(page * pageSize, page * pageSize + pageSize - 1);
        if (error) throw new AdminRepositoryError("unavailable");
        records.push(...data);
        if (data.length < pageSize) break;
      }

      const userIds = records.map(({ user_id }) => user_id);
      const rolesByUser = new Map<string, MentorAdminRole[]>();
      for (let offset = 0; offset < userIds.length; offset += 200) {
        const { data, error } = await supabaseAdmin
          .from("user_roles")
          .select("user_id, role")
          .in("user_id", userIds.slice(offset, offset + 200))
          .in("role", ["mentor", "team_admin"]);
        if (error) throw new AdminRepositoryError("unavailable");
        for (const row of data) {
          const roles = rolesByUser.get(row.user_id) ?? [];
          roles.push(row.role as MentorAdminRole);
          rolesByUser.set(row.user_id, roles);
        }
      }

      return records.map((record) => ({
        userId: record.user_id,
        username: record.username,
        isActive: record.is_active,
        mustChangePassword: record.must_change_password,
        roles: rolesByUser.get(record.user_id) ?? [],
        createdAt: record.created_at,
        disabledAt: record.disabled_at,
      }));
    },
    async provisionStaffAccount(input) {
      const { error } = await supabaseAdmin.rpc("provision_staff_account", {
        _user_id: input.userId,
        _username: input.username,
        _auth_identity_version: 1,
        _created_by: input.createdBy,
        _is_team_admin: input.isTeamAdmin,
      });
      if (error) throw repositoryError(error);
    },
    async bootstrapStaffAccount(input) {
      const { error } = await supabaseAdmin.rpc("bootstrap_staff_account", {
        _user_id: input.userId,
        _username: input.username,
        _auth_identity_version: 1,
        _is_team_admin: input.isTeamAdmin,
      });
      if (error) throw repositoryError(error);
    },
    async beginStaffActiveOperation(input) {
      const { error } = await supabaseAdmin.rpc("admin_begin_staff_active_operation", {
        _actor_user_id: input.actorUserId,
        _target_user_id: input.targetUserId,
        _is_active: input.isActive,
        _operation_token: input.operationToken,
      });
      if (error) throw repositoryError(error);
    },
    async getStaffActiveSyncState(input) {
      const { data, error } = await supabaseAdmin.rpc("admin_get_staff_active_sync_state", {
        _actor_user_id: input.actorUserId,
        _target_user_id: input.targetUserId,
      });
      if (error) throw repositoryError(error);
      return {
        version: readNumberResult(data, "version"),
        operationToken: readNullableStringResult(data, "operation_token"),
        desiredActive: readBooleanResult(data, "desired_active"),
      };
    },
    async confirmStaffActiveSync(input) {
      const { data, error } = await supabaseAdmin.rpc("admin_confirm_staff_active_sync", {
        _actor_user_id: input.actorUserId,
        _target_user_id: input.targetUserId,
        _observed_version: input.observedVersion,
        _operation_token: input.operationToken,
      });
      if (error) throw repositoryError(error);
      return {
        confirmed: readBooleanResult(data, "confirmed"),
        active: readBooleanResult(data, "active"),
      };
    },
    async beginPasswordReset(input) {
      const { data, error } = await supabaseAdmin.rpc("admin_begin_staff_password_reset", {
        _actor_user_id: input.actorUserId,
        _target_user_id: input.targetUserId,
        _operation_token: input.operationToken,
      });
      if (error) throw repositoryError(error);
      return { previousValue: readBooleanResult(data, "previous_value") };
    },
    async finishPasswordReset(input) {
      const { data, error } = await supabaseAdmin.rpc("admin_finish_staff_password_reset", {
        _actor_user_id: input.actorUserId,
        _target_user_id: input.targetUserId,
        _operation_token: input.operationToken,
        _succeeded: input.succeeded,
      });
      if (error) throw repositoryError(error);
      return { applied: readBooleanResult(data, "applied") };
    },
  };

  return createMentorAdminService({
    auth,
    repository,
    allowTrustedBootstrap: options?.allowTrustedBootstrap,
  });
}

export async function listMentorsOnServer(callerUserId: string): Promise<MentorAccountDto[]> {
  const service = await createProductionMentorAdminService();
  return service.listMentors({
    actor: { kind: "staff", userId: callerUserId },
  });
}

export async function createMentorOnServer(input: {
  callerUserId: string;
  username: string;
  temporaryPassword: string;
  isTeamAdmin: boolean;
}): Promise<CreatedMentorAccount> {
  const service = await createProductionMentorAdminService();
  return service.createMentor({
    actor: { kind: "staff", userId: input.callerUserId },
    username: input.username,
    temporaryPassword: input.temporaryPassword,
    isTeamAdmin: input.isTeamAdmin,
  });
}

export async function setMentorActiveOnServer(input: {
  callerUserId: string;
  targetUserId: string;
  isActive: boolean;
}): Promise<{ ok: true }> {
  const service = await createProductionMentorAdminService();
  return service.setMentorActive({
    actor: { kind: "staff", userId: input.callerUserId },
    targetUserId: input.targetUserId,
    isActive: input.isActive,
  });
}

export async function resetMentorTemporaryPasswordOnServer(input: {
  callerUserId: string;
  targetUserId: string;
  temporaryPassword: string;
}): Promise<{ ok: true }> {
  const service = await createProductionMentorAdminService();
  return service.resetTemporaryPassword({
    actor: { kind: "staff", userId: input.callerUserId },
    targetUserId: input.targetUserId,
    temporaryPassword: input.temporaryPassword,
  });
}
