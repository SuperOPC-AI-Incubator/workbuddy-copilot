export interface PasswordChangeGateway {
  updateAuthPassword(userId: string, password: string): Promise<void>;
  completePasswordChange(userId: string): Promise<void>;
}

export type PasswordChangeInput = {
  userId: string;
  newPassword: string;
};

export type PasswordChangeResult = {
  ok: true;
};

const AUTH_UPDATE_ERROR = "密码更新失败，请稍后重试。";
const COMPLETION_ERROR = "密码已更新，但账号状态确认失败，请重试。";

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

    return { ok: true };
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
  });

  return changePassword(input);
}
