import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ShieldCheck, UserCog, UserPlus, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { supabase } from "@/integrations/supabase/client";
import {
  createMentorAccount,
  listMentors,
  resetMentorAccountPassword,
  setMentorAccountActive,
} from "@/lib/auth/admin.functions";

export const Route = createFileRoute("/_authenticated/admin/mentors")({
  component: MentorAccountsPage,
});

type MentorAccount = Awaited<ReturnType<typeof listMentors>>[number];

function formatTimestamp(value: string | null): string {
  if (!value) return "尚未登录";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusLabel(account: MentorAccount): string {
  if (!account.active) return "已停用";
  if (account.mustChangePassword) return "待首次改密";
  return "可用";
}

function MentorAccountsPage() {
  const listFn = useServerFn(listMentors);
  const createFn = useServerFn(createMentorAccount);
  const setActiveFn = useServerFn(setMentorAccountActive);
  const resetPasswordFn = useServerFn(resetMentorAccountPassword);
  const [accounts, setAccounts] = useState<MentorAccount[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [isTeamAdmin, setIsTeamAdmin] = useState(false);
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const next = await listFn();
    setAccounts(next);
  }, [listFn]);

  useEffect(() => {
    let mounted = true;
    Promise.all([supabase.auth.getUser(), listFn()])
      .then(([userResult, mentorAccounts]) => {
        if (!mounted) return;
        setCurrentUserId(userResult.data.user?.id ?? "");
        setAccounts(mentorAccounts);
      })
      .catch(() => {
        if (mounted) setDenied(true);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [listFn]);

  const summary = useMemo(
    () => ({
      total: accounts.length,
      active: accounts.filter(({ active }) => active).length,
      pending: accounts.filter(({ active, mustChangePassword }) => active && mustChangePassword)
        .length,
      admins: accounts.filter(({ roles }) => roles.includes("team_admin")).length,
    }),
    [accounts],
  );

  const showError = (error: unknown, fallback: string) => {
    setMessage(null);
    setErrorMessage(error instanceof Error ? error.message : fallback);
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setBusyKey("create");
    setMessage(null);
    setErrorMessage(null);
    try {
      await createFn({
        data: {
          username,
          temporaryPassword: createPassword,
          isTeamAdmin,
        },
      });
      setUsername("");
      setIsTeamAdmin(false);
      setMessage("导师账号已创建。临时密码不会在此页面再次显示。");
      await refresh();
    } catch (error) {
      showError(error, "导师账号创建失败");
    } finally {
      setCreatePassword("");
      setBusyKey(null);
    }
  };

  const handleSetActive = async (account: MentorAccount) => {
    const nextActive = !account.active;
    const confirmed = window.confirm(
      nextActive
        ? `确认启用导师账号“${account.username}”？`
        : `确认停用导师账号“${account.username}”？其现有会话将立即失去数据访问权限。`,
    );
    if (!confirmed) return;

    setBusyKey(`active:${account.userId}`);
    setMessage(null);
    setErrorMessage(null);
    try {
      await setActiveFn({
        data: {
          targetUserId: account.userId,
          isActive: nextActive,
        },
      });
      setMessage(nextActive ? "账号已启用。" : "账号已停用。");
      await refresh();
    } catch (error) {
      showError(error, "账号状态更新失败");
      await refresh().catch(() => {});
    } finally {
      setBusyKey(null);
    }
  };

  const handleResetPassword = async (account: MentorAccount) => {
    const temporaryPassword = resetPasswords[account.userId] ?? "";
    if (!window.confirm(`确认重置导师账号“${account.username}”的临时密码？`)) return;

    setBusyKey(`reset:${account.userId}`);
    setMessage(null);
    setErrorMessage(null);
    try {
      await resetPasswordFn({
        data: {
          targetUserId: account.userId,
          temporaryPassword,
        },
      });
      setMessage("临时密码已重置；该导师下次登录后必须修改密码。");
      await refresh();
    } catch (error) {
      showError(error, "临时密码重置失败");
      await refresh().catch(() => {});
    } finally {
      setResetPasswords((current) => ({ ...current, [account.userId]: "" }));
      setBusyKey(null);
    }
  };

  if (loading) {
    return (
      <main className="grid min-h-screen place-items-center bg-background text-foreground">
        <p className="text-sm text-muted-foreground">正在核验管理员权限…</p>
      </main>
    );
  }

  if (denied) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <section className="max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm">
          <ShieldCheck className="mx-auto h-10 w-10 text-muted-foreground" />
          <h1 className="mt-4 text-xl font-semibold">无法访问导师账号管理</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            此页面仅向已启用、已完成改密的团队管理员开放。
          </p>
          <Link
            to="/"
            className="mt-6 inline-flex rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
          >
            返回导师观察台
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header
        className="border-b"
        style={{ background: "var(--sidebar-bg)", color: "var(--sidebar-fg)" }}
      >
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-5">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-cyan-200/70">
              <UserCog className="h-4 w-4" />
              Team administration
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">导师账号</h1>
            <p className="mt-1 text-sm" style={{ color: "var(--sidebar-muted)" }}>
              创建、停用和恢复独立导师身份
            </p>
          </div>
          <Link
            to="/"
            className="rounded-md border border-white/15 px-3 py-2 text-sm transition-colors hover:bg-white/10"
          >
            返回观察台
          </Link>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-6 py-7 lg:grid-cols-[340px_1fr]">
        <aside className="space-y-5">
          <section className="grid grid-cols-2 gap-3">
            {[
              ["账号", summary.total],
              ["可登录", summary.active],
              ["待改密", summary.pending],
              ["管理员", summary.admins],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="text-xs text-muted-foreground">{label}</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
              </div>
            ))}
          </section>

          <form onSubmit={handleCreate} className="rounded-2xl border bg-card p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-primary" />
              <h2 className="font-semibold">创建导师账号</h2>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              导师首次登录后必须设置自己的新密码。
            </p>

            <label className="mt-5 block text-xs font-medium" htmlFor="mentor-username">
              用户名
            </label>
            <input
              id="mentor-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              required
              className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="例如 mentor.name"
            />

            <label className="mt-4 block text-xs font-medium" htmlFor="mentor-temp-password">
              临时密码
            </label>
            <input
              id="mentor-temp-password"
              type="password"
              value={createPassword}
              onChange={(event) => setCreatePassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              maxLength={256}
              required
              className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />

            <label className="mt-4 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={isTeamAdmin}
                onChange={(event) => setIsTeamAdmin(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
              />
              <span>
                同时设为团队管理员
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  可继续创建和管理其他导师账号
                </span>
              </span>
            </label>

            <button
              type="submit"
              disabled={busyKey !== null}
              className="mt-5 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busyKey === "create" ? "正在创建…" : "创建账号"}
            </button>
          </form>
        </aside>

        <section className="min-w-0">
          {(message || errorMessage) && (
            <div
              className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
                errorMessage
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "border-emerald-600/25 bg-emerald-500/10 text-emerald-800"
              }`}
              role="status"
            >
              {errorMessage ?? message}
            </div>
          )}

          <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                <h2 className="font-semibold">全部导师</h2>
              </div>
              <span className="text-xs text-muted-foreground">{accounts.length} 个账号</span>
            </div>

            {accounts.length === 0 ? (
              <p className="p-10 text-center text-sm text-muted-foreground">暂无导师账号</p>
            ) : (
              <div className="divide-y">
                {accounts.map((account) => {
                  const isSelf = account.userId === currentUserId;
                  const statusClass = !account.active
                    ? "bg-slate-500/10 text-slate-600"
                    : account.mustChangePassword
                      ? "bg-amber-500/10 text-amber-700"
                      : "bg-emerald-500/10 text-emerald-700";
                  return (
                    <article key={account.userId} className="p-5">
                      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-semibold">{account.username}</h3>
                            {isSelf && (
                              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                                当前账号
                              </span>
                            )}
                            <span className={`rounded-full px-2 py-0.5 text-[11px] ${statusClass}`}>
                              {statusLabel(account)}
                            </span>
                            {account.roles.includes("team_admin") && (
                              <span className="rounded-full bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-700">
                                团队管理员
                              </span>
                            )}
                          </div>
                          <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                            <div>
                              <dt className="inline">最近登录：</dt>
                              <dd className="inline">{formatTimestamp(account.lastLoginAt)}</dd>
                            </div>
                            <div>
                              <dt className="inline">创建时间：</dt>
                              <dd className="inline">{formatTimestamp(account.createdAt)}</dd>
                            </div>
                            {account.disabledAt && (
                              <div className="sm:col-span-2">
                                <dt className="inline">停用时间：</dt>
                                <dd className="inline">{formatTimestamp(account.disabledAt)}</dd>
                              </div>
                            )}
                          </dl>
                        </div>

                        <button
                          type="button"
                          disabled={isSelf || busyKey !== null}
                          title={isSelf ? "不能停用自己的账号" : undefined}
                          onClick={() => handleSetActive(account)}
                          className={`shrink-0 rounded-md border px-3 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                            account.active
                              ? "border-destructive/30 text-destructive hover:bg-destructive/10"
                              : "border-emerald-600/30 text-emerald-700 hover:bg-emerald-500/10"
                          }`}
                        >
                          {busyKey === `active:${account.userId}`
                            ? "处理中…"
                            : account.active
                              ? "停用账号"
                              : "启用账号"}
                        </button>
                      </div>

                      {isSelf ? (
                        <p className="mt-4 rounded-lg bg-muted/55 p-3 text-xs text-muted-foreground">
                          当前账号请通过修改密码流程更新密码，不能在此重置临时密码。
                        </p>
                      ) : (
                        <form
                          className="mt-4 flex flex-col gap-2 rounded-lg bg-muted/55 p-3 sm:flex-row"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void handleResetPassword(account);
                          }}
                        >
                          <input
                            type="password"
                            value={resetPasswords[account.userId] ?? ""}
                            onChange={(event) =>
                              setResetPasswords((current) => ({
                                ...current,
                                [account.userId]: event.target.value,
                              }))
                            }
                            autoComplete="new-password"
                            minLength={8}
                            maxLength={256}
                            required
                            placeholder="输入新的临时密码"
                            aria-label={`重置 ${account.username} 的临时密码`}
                            className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                          />
                          <button
                            type="submit"
                            disabled={busyKey !== null}
                            className="rounded-md border bg-background px-3 py-2 text-xs font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {busyKey === `reset:${account.userId}` ? "正在重置…" : "重置临时密码"}
                          </button>
                        </form>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
