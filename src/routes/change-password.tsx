import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState, type FormEvent } from "react";

import { supabase } from "@/integrations/supabase/client";
import { getStaffAccessDecision, safePostAuthPath } from "@/lib/auth/navigation";
import { changeOwnPassword } from "@/lib/auth/password-change.functions";

export const Route = createFileRoute("/change-password")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    next: safePostAuthPath(search.next),
  }),
  beforeLoad: async ({ search }) => {
    const safeNext = safePostAuthPath(search.next);
    const { data, error } = await supabase.auth.getUser();

    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { next: safeNext } });
    }

    const { data: staff, error: staffError } = await supabase
      .from("staff_accounts")
      .select("is_active, must_change_password")
      .eq("user_id", data.user.id)
      .maybeSingle();

    if (staffError) {
      await supabase.auth.signOut();
      throw redirect({ to: "/auth", search: { next: safeNext } });
    }

    const decision = getStaffAccessDecision(
      staff
        ? {
            isActive: staff.is_active,
            mustChangePassword: staff.must_change_password,
          }
        : null,
    );

    if (!staff || decision === "allow") {
      throw redirect({ href: safeNext });
    }

    if (decision === "sign_out") {
      await supabase.auth.signOut();
      throw redirect({ to: "/auth", search: { next: safeNext } });
    }
  },
  component: ChangePasswordPage,
});

function ChangePasswordPage() {
  const navigate = useNavigate();
  const changePasswordFn = useServerFn(changeOwnPassword);
  const { next } = Route.useSearch();
  const safeNext = safePostAuthPath(next);
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirmation) {
      setError("两次输入的新密码不一致。");
      return;
    }

    setBusy(true);
    try {
      const changed = await changePasswordFn({
        data: {
          newPassword,
        },
      });

      const { error: sessionError } = await supabase.auth.setSession({
        access_token: changed.session.accessToken,
        refresh_token: changed.session.refreshToken,
      });
      if (sessionError) {
        await supabase.auth.signOut();
        await navigate({
          to: "/auth",
          search: { next: safeNext },
          replace: true,
        });
        return;
      }

      await navigate({ href: safeNext, replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "密码更新失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    await navigate({ to: "/auth", search: { next: safeNext }, replace: true });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <section className="w-full max-w-sm rounded-xl border bg-card p-8 shadow-sm">
        <div className="mb-6 text-center">
          <div
            className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-md font-bold"
            style={{
              background: "var(--primary)",
              color: "var(--primary-foreground)",
            }}
          >
            W
          </div>
          <h1 className="text-lg font-semibold">首次登录请修改密码</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            当前登录会话已验证。设置自己的新密码后才能进入导师工作台。
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block text-xs">
            <span className="mb-1 block text-muted-foreground">新密码</span>
            <input
              type="password"
              required
              minLength={8}
              maxLength={256}
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              placeholder="至少 8 位"
            />
          </label>

          <label className="block text-xs">
            <span className="mb-1 block text-muted-foreground">确认新密码</span>
            <input
              type="password"
              required
              minLength={8}
              maxLength={256}
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              placeholder="再次输入新密码"
            />
          </label>

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
          >
            {busy ? "更新中…" : "更新密码并继续"}
          </button>
        </form>

        <button
          type="button"
          onClick={signOut}
          className="mt-3 w-full rounded-md border py-2 text-xs text-muted-foreground hover:bg-accent"
        >
          退出登录
        </button>
      </section>
    </main>
  );
}
