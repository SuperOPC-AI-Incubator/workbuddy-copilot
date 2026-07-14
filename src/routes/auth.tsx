import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  ssr: false,
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user) navigate({ to: "/", replace: true });
    });
  }, [navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: window.location.origin,
            data: { display_name: displayName || email.split("@")[0] },
          },
        });
        if (error) throw error;
        if (data.session) navigate({ to: "/", replace: true });
        else setInfo("注册成功，请查收邮箱验证链接后再登录。");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate({ to: "/", replace: true });
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
            <label className="block text-xs">
              <span className="mb-1 block text-muted-foreground">昵称（可选）</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                placeholder="张老师"
              />
            </label>
          )}
          <label className="block text-xs">
            <span className="mb-1 block text-muted-foreground">邮箱</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              placeholder="mentor@example.com"
            />
          </label>
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
            <p className="rounded-md border border-primary/30 bg-primary/10 p-2 text-xs">
              {info}
            </p>
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
          登录后可实时观察学员 PLC 学习过程。
          <br />
          <Link to="/" className="underline">返回首页</Link>
        </p>
      </div>
    </div>
  );
}