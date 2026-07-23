import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { buildWorkbuddySkill } from "@/lib/workbuddy/skill-template";

export const Route = createFileRoute("/_authenticated/workbuddy")({
  component: WorkBuddySetup,
});

const INGEST_PATH = "/api/public/workbuddy/ingest";
const CREDENTIAL_PLACEHOLDER = "<WORKBUDDY_CREDENTIAL>";

function WorkBuddySetup() {
  const [ingestUrl, setIngestUrl] = useState(`https://<copilot-host>${INGEST_PATH}`);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setIngestUrl(new URL(INGEST_PATH, window.location.origin).toString());
  }, []);

  const skillMd = buildWorkbuddySkill({
    ingestUrl,
    credentialPlaceholder: CREDENTIAL_PLACEHOLDER,
  });

  const copySkill = async () => {
    try {
      await navigator.clipboard.writeText(skillMd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">WorkBuddy 一键接入</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            这是新的可靠同步格式：每轮可安全重试，并以本地对话稳定键持续归入同一个导师会话。
          </p>
        </header>

        <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <div className="font-medium">旧版 Skill 必须更新</div>
          <p className="mt-1 text-muted-foreground">
            如果已经安装过使用 session/items
            的旧版，请删除后重新安装本页版本。旧格式不再进入可靠同步主路径。
          </p>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <div className="text-sm font-medium">接入凭证 · 即将开放</div>
          <p className="mt-2 text-sm text-muted-foreground">
            本页已停止读取和展示旧明文
            Token。新的凭证管理完成后，会在这里一次性生成可撤销的接入凭证，并自动替换模板中的
            <code className="mx-1">{CREDENTIAL_PLACEHOLDER}</code>。
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            当前可以先检查和复制可靠格式模板，但在凭证生成前不要直接安装使用。
          </p>
        </section>

        <section className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">新版 SKILL.md 模板</div>
              <div className="text-xs text-muted-foreground">
                每轮 event_id 唯一；同轮重试复用；同一对话复用 source_session_key。
              </div>
            </div>
            <button
              type="button"
              onClick={copySkill}
              className="shrink-0 rounded-md border border-border bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
            >
              {copied ? "已复制" : "复制模板"}
            </button>
          </div>
          <pre className="max-h-[520px] overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
            {skillMd}
          </pre>
        </section>

        <section className="rounded-lg border border-border bg-card p-4 text-sm">
          <div className="mb-2 font-medium">更新步骤</div>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>删除 WorkBuddy 中旧的 superbrain-sync Skill。</li>
            <li>等本页生成新的接入凭证后，再复制完整新版模板。</li>
            <li>新对话首轮生成 source_session_key，此后持续复用；每轮另生成 event_id。</li>
          </ol>
        </section>
      </div>
    </div>
  );
}
