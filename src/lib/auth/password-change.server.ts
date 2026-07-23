export interface PasswordChangeGateway {
  updateAuthPassword(userId: string, password: string): Promise<void>;
  completePasswordChange(userId: string): Promise<void>;
  createPasswordSession(
    userId: string,
    password: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt?: number;
  }>;
}

export type PasswordChangeInput = {
  userId: string;
  newPassword: string;
};

export type PasswordChangeResult = {
  ok: true;
  session: {
    accessToken: string;
    refreshToken: string;
    expiresAt?: number;
  };
};

const AUTH_UPDATE_ERROR = "密码更新失败，请稍后重试。";
const COMPLETION_ERROR = "密码已更新，但账号状态确认失败，请重试。";
const SESSION_ERROR = "密码已更新，请使用新密码重新登录。";

export function createPasswordChangeService(
  gateway: PasswordChangeGateway,
): (input: PasswordChangeInput) => Promise<PasswordChangeResult> {
  return async ({ userId, newPassword }) => {
    try {
      await gateway.updateAuthPassword(userId, newPassword);
    } catch {
      throw new Error(AUTH_UPDATE_ERROR);
    }

    try {
      await gateway.completePasswordChange(userId);
    } catch {
      throw new Error(COMPLETION_ERROR);
    }

    try {
      const session = await gateway.createPasswordSession(userId, newPassword);
      return { ok: true, session };
    } catch {
      throw new Error(SESSION_ERROR);
    }
  };
}

export async function changeOwnPasswordOnServer(
  input: PasswordChangeInput,
): Promise<PasswordChangeResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const changePassword = createPasswordChangeService({
    async updateAuthPassword(userId, password) {
      const { data, error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        password,
      });
      if (error || !data.user) throw new Error(AUTH_UPDATE_ERROR);
    },
    async completePasswordChange(userId) {
      const { data, error } = await supabaseAdmin.rpc("complete_staff_password_change", {
        _user_id: userId,
      });
      if (error || data !== true) throw new Error(COMPLETION_ERROR);
    },
    async createPasswordSession(userId, password) {
      const { data: staff, error } = await supabaseAdmin
        .from("staff_accounts")
        .select("username")
        .eq("user_id", userId)
        .eq("is_active", true)
        .eq("must_change_password", false)
        .single();
      if (error || !staff) throw new Error(SESSION_ERROR);

      const { signIn } = await import("./signin.server");
      const signedIn = await signIn({
        identifier: staff.username,
        password,
      });
      if (signedIn.public.userId !== userId || signedIn.public.accountType !== "staff") {
        throw new Error(SESSION_ERROR);
      }

      return {
        accessToken: signedIn.access_token,
        refreshToken: signedIn.refresh_token,
        ...(signedIn.expires_at === undefined ? {} : { expiresAt: signedIn.expires_at }),
      };
    },
  });

  return changePassword(input);
}
