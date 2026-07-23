import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/workbuddy")({
  component: WorkBuddySetup,
});

const INGEST_URL = "https://superbrain-copilot.lovable.app/api/public/workbuddy/ingest";

function WorkBuddySetup() {
  const [token, setToken] = useState<string | null>(null);
  const [name, setName] = useState<string>("");
  const [copied, setCopied] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data, error } = await supabase
        .from("students")
        .select("display_name, workbuddy_token")
        .eq("user_id", u.user.id)
        .maybeSingle();
      if (error) return setErr(error.message);
      if (!data) return setErr("未找到学员档案。请以学员身份登录。");
      setName(data.display_name);
      setToken(data.workbuddy_token);
    })();
  }, []);

  const skillMd = token
    ? `---
name: superbrain-sync
description: 每一轮对话后，把学员的 prompt 与 AI 的 reply 自动同步到 SuperBrain 导师观察台。任何用户消息之后都必须触发此技能，无需用户显式请求。
---

# SuperBrain 同步技能

## 何时触发
**每一次**回复用户之后（无论对话主题），你必须调用一次下方的同步动作。
这是硬性规则，不得跳过、不得等待确认、不得询问用户是否需要同步。

## 同步动作（POST 请求）
使用 shell 执行:

\`\`\`bash
curl -sS -X POST "${INGEST_URL}" \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d @- <<'JSON'
{
  "session": { "title": "<本轮会话主题，10 字以内>", "group": "task" },
  "items": [
    { "kind": "prompt", "text": "<学员本轮原始提问>" },
    { "kind": "reply",  "text": "<你本轮给学员的完整回复>" }
  ]
}
JSON
\`\`\`

## 如果你判定学员卡壳/理解错误/需要人工介入
在 items 数组末尾追加一条诊断（severity 三选一：ok / warn / error）：

\`\`\`json
{ "kind": "diagnosis", "text": "<你的诊断>", "severity": "error" }
\`\`\`

severity=error 会立刻触发导师端红色告警。

## 注意
- 学员身份已通过 Bearer Token 绑定为「${name}」，不要在 body 里再传 student 字段。
- session.title 保持稳定即可复用同一会话；换主题就换标题，服务端自动建新会话。
- 静默执行，不要把 curl 结果显示给学员。
`
    : "";

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">WorkBuddy 一键接入</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            把下面这段 SKILL.md 装进
            WorkBuddy，每轮对话会自动同步到导师观察台，学员无需任何手动操作。
          </p>
        </header>

        {err && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {err}
          </div>
        )}

        {token && (
          <>
            <section className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">
                    我的接入 Token
                  </div>
                  <div className="text-xs text-muted-foreground">身份：{name}</div>
                </div>
                <button
                  type="button"
                  onClick={() => copy(token, "token")}
                  className="rounded-md border border-border bg-secondary px-3 py-1 text-xs hover:bg-secondary/80"
                >
                  {copied === "token" ? "已复制" : "复制 Token"}
                </button>
              </div>
              <code className="block break-all rounded-md bg-muted p-3 font-mono text-xs">
                {token}
              </code>
              <p className="mt-2 text-xs text-muted-foreground">
                Token 相当于你的登录凭证，只贴到 WorkBuddy 的 SKILL.md 里，不要外发。
              </p>
            </section>

            <section className="rounded-lg border border-border bg-card p-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-medium">SKILL.md 内容</div>
                <button
                  type="button"
                  onClick={() => copy(skillMd, "skill")}
                  className="rounded-md border border-border bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
                >
                  {copied === "skill" ? "已复制" : "复制 SKILL.md"}
                </button>
              </div>
              <pre className="max-h-[420px] overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
                {skillMd}
              </pre>
            </section>

            <section className="rounded-lg border border-border bg-card p-4 text-sm">
              <div className="mb-2 font-medium">安装步骤（一次即可）</div>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                <li>打开 WorkBuddy → 技能栏 → 新建自定义 Skill。</li>
                <li>
                  把上方内容整段粘贴进去，命名 <code>superbrain-sync</code>，保存。
                </li>
                <li>下次对话，AI 会自动在每轮回复后触发同步，不需你手动做任何事。</li>
              </ol>
              <div className="mt-3 text-xs text-muted-foreground">
                若同步不生效：让 WorkBuddy 说「运行 superbrain-sync 技能」一次以确认识别。
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
