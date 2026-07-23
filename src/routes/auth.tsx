import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { buildChangePasswordHref, safePostAuthPath } from "@/lib/auth/navigation";
import { signIn } from "@/lib/auth/signin.functions";

export const Route = createFileRoute("/auth")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    next: safePostAuthPath(s.next),
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const safeNext = safePostAuthPath(next);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [identifier, setIdentifier] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const signInFn = useServerFn(signIn);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) void navigate({ href: safeNext, replace: true });
    });
  }, [navigate, safeNext]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: signupEmail,
          password,
          options: {
            emailRedirectTo: window.location.origin + safeNext,
            data: {
              display_name: displayName || signupEmail.split("@")[0],
              role: "student",
            },
          },
        });
        if (error) throw error;
        if (data.session) await navigate({ href: safeNext, replace: true });
        else setInfo("注册成功，请查收邮箱验证链接后再登录。");
      } else {
        const session = await signInFn({
          data: { identifier, password },
        });
        const { error } = await supabase.auth.setSession({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        });
        if (error) throw new Error("登录会话建立失败，请重试。");
        // Supabase sessions retain their opaque Auth email claim. Display identity
        // must always come from the public DTO/profile, never from that session claim.
        const destination =
          session.public.accountType === "staff" && session.public.mustChangePassword
            ? buildChangePasswordHref(safeNext)
            : safeNext;
        await navigate({ href: destination, replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "认证失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-8 shadow-sm">
        <div className="mb-6 text-center">
          <div
            className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-md font-bold"
            style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
          >
            W
          </div>
          <h1 className="text-lg font-semibold">WorkBuddy Copilot</h1>
          <p className="mt-1 text-xs text-muted-foreground">导师观察台 · 请登录以继续</p>
        </div>
        <div className="mb-4 flex rounded-md border p-0.5 text-sm">
          <button
            type="button"
            onClick={() => setMode("signin")}
            className={`flex-1 rounded px-3 py-1.5 transition-colors ${mode === "signin" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
          >
            登录
          </button>
          <button
            type="button"
            onClick={() => setMode("signup")}
            className={`flex-1 rounded px-3 py-1.5 transition-colors ${mode === "signup" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
          >
            注册
          </button>
        </div>
        <form onSubmit={onSubmit} className="space-y-3">
          {mode === "signup" && (
            <>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">昵称（可选）</span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                  placeholder="陈同学"
                />
              </label>
              <p className="rounded-md bg-muted px-3 py-2 text-[11px] text-muted-foreground">
                公开注册只会创建学员账号。
              </p>
            </>
          )}
          {mode === "signup" ? (
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">学员邮箱</span>
              <input
                type="email"
                required
                value={signupEmail}
                onChange={(e) => setSignupEmail(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                placeholder="student@example.com"
              />
            </label>
          ) : (
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">用户名或学员邮箱</span>
              <input
                type="text"
                required
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                placeholder="导师用户名 / student@example.com"
                autoComplete="username"
              />
            </label>
          )}
          <label className="block text-xs">
            <span className="mb-1 block text-muted-foreground">密码</span>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              placeholder="至少 6 位"
            />
          </label>
          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {error}
            </p>
          )}
          {info && (
            <p className="rounded-md border border-primary/30 bg-primary/10 p-2 text-xs">{info}</p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
          >
            {busy ? "处理中…" : mode === "signin" ? "登录" : "注册"}
          </button>
        </form>
        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          登录后可实时观察学员的学习过程。
          <br />
          <Link to="/" className="underline">
            返回首页
          </Link>
        </p>
      </div>
    </div>
  );
}
