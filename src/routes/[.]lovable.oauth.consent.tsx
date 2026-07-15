import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// The supabase.auth.oauth namespace is beta and not typed in supabase-js yet.
// Local typed wrapper for the three methods we call.
type OAuthAuthDetails = {
  client?: { name?: string; client_uri?: string; logo_uri?: string };
  redirect_url?: string;
  redirect_to?: string;
};
type OAuthApi = {
  getAuthorizationDetails: (id: string) => Promise<{ data: OAuthAuthDetails | null; error: Error | null }>;
  approveAuthorization: (id: string) => Promise<{ data: OAuthAuthDetails | null; error: Error | null }>;
  denyAuthorization: (id: string) => Promise<{ data: OAuthAuthDetails | null; error: Error | null }>;
};
function oauthApi(): OAuthApi {
  return (supabase.auth as unknown as { oauth: OAuthApi }).oauth;
}

export const Route = createFileRoute("/.lovable/oauth/consent")({
  ssr: false,
  validateSearch: (s: Record<string, unknown>) => ({
    authorization_id: typeof s.authorization_id === "string" ? s.authorization_id : "",
  }),
  beforeLoad: async ({ search, location }) => {
    if (!search.authorization_id) throw new Error("Missing authorization_id");
    const { data } = await supabase.auth.getSession();
    const next = location.pathname + location.searchStr;
    if (!data.session) throw redirect({ to: "/auth", search: { next } });
  },
  loader: async ({ location }) => {
    const authorizationId = new URLSearchParams(location.search).get("authorization_id")!;
    const { data, error } = await oauthApi().getAuthorizationDetails(authorizationId);
    if (error) throw error;
    const immediate = data?.redirect_url ?? data?.redirect_to;
    if (immediate && !data?.client) throw redirect({ href: immediate });
    return data;
  },
  component: Consent,
  errorComponent: ({ error }) => (
    <main className="mx-auto max-w-md p-6 text-sm">
      <h1 className="mb-2 text-base font-semibold">授权请求无法加载</h1>
      <p className="text-muted-foreground">{String((error as Error)?.message ?? error)}</p>
    </main>
  ),
});

function Consent() {
  const details = Route.useLoaderData() as OAuthAuthDetails | null;
  const { authorization_id } = Route.useSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const clientName = details?.client?.name ?? "第三方应用";

  async function decide(approve: boolean) {
    setBusy(true);
    setError(null);
    const { data, error } = approve
      ? await oauthApi().approveAuthorization(authorization_id)
      : await oauthApi().denyAuthorization(authorization_id);
    if (error) {
      setBusy(false);
      setError(error.message);
      return;
    }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) {
      // Supabase 未返回跳转地址,但授权本身已经成功。
      // 直接尝试关闭窗口(popup 场景);无法关闭时显示成功提示。
      setBusy(false);
      setDone(true);
      setTimeout(() => window.close(), 300);
      return;
    }
    window.location.href = target;
  }

  if (done) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
        <div className="rounded-xl border bg-card p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold">授权成功 ✅</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {clientName} 已连接到你的账号。你可以关闭这个窗口,返回 WorkBuddy 继续使用。
          </p>
          <button
            onClick={() => window.close()}
            className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            关闭窗口
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="rounded-xl border bg-card p-8 shadow-sm">
        <h1 className="text-lg font-semibold">授权 {clientName} 连接你的账号</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {clientName} 将以你的身份读取和写入 WorkBuddy Copilot 的会话与 timeline 数据(仅限你自己的数据,行级权限自动生效)。
        </p>
        <ul className="mt-4 space-y-1 text-xs text-muted-foreground">
          <li>• 创建 / 读取你的学习会话</li>
          <li>• 同步 WorkBuddy 中的提问、AI 回复与诊断</li>
          <li>• 呼叫导师</li>
        </ul>
        {error && (
          <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="mt-6 flex gap-2">
          <button
            disabled={busy}
            onClick={() => decide(false)}
            className="flex-1 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent disabled:opacity-50"
          >
            拒绝
          </button>
          <button
            disabled={busy}
            onClick={() => decide(true)}
            className="flex-1 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
          >
            {busy ? "处理中…" : "同意授权"}
          </button>
        </div>
      </div>
    </main>
  );
}