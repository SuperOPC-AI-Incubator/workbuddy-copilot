import { Link, createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createWorkbuddyCredential,
  getWorkbuddyCredentialStatus,
  revokeWorkbuddyCredential,
  rotateWorkbuddyCredential,
} from "@/lib/workbuddy/credentials.functions";
import { buildWorkbuddySkill } from "@/lib/workbuddy/skill-template";

export const Route = createFileRoute("/_authenticated/workbuddy")({
  component: WorkBuddySetup,
});

const INGEST_PATH = "/api/public/workbuddy/ingest";
type CredentialStatus = Awaited<ReturnType<typeof getWorkbuddyCredentialStatus>>;

function formatTimestamp(value: string | null): string {
  if (!value) return "尚未使用";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function WorkBuddySetup() {
  const getStatus = useServerFn(getWorkbuddyCredentialStatus);
  const createCredential = useServerFn(createWorkbuddyCredential);
  const rotateCredential = useServerFn(rotateWorkbuddyCredential);
  const revokeCredential = useServerFn(revokeWorkbuddyCredential);
  const [status, setStatus] = useState<CredentialStatus>({
    status: "none",
    credential: null,
  });
  const [oneTimeToken, setOneTimeToken] = useState<string | null>(null);
  const [ingestUrl, setIngestUrl] = useState(`https://<copilot-host>${INGEST_PATH}`);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"create" | "rotate" | "revoke" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<"token" | "skill" | null>(null);

  useEffect(() => {
    setIngestUrl(new URL(INGEST_PATH, window.location.origin).toString());
  }, []);

  useEffect(() => {
    let mounted = true;
    getStatus()
      .then((next) => {
        if (mounted) setStatus(next);
      })
      .catch(() => {
        if (mounted) setErrorMessage("无法读取接入凭证状态，请确认当前是学员账号。");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [getStatus]);

  const skillMd = useMemo(
    () =>
      oneTimeToken
        ? buildWorkbuddySkill({
            ingestUrl,
            credentialPlaceholder: oneTimeToken,
          })
        : null,
    [ingestUrl, oneTimeToken],
  );

  const runIssue = useCallback(
    async (mode: "create" | "rotate") => {
      if (mode === "rotate" && !window.confirm("轮换后旧凭证会立即失效。确认生成新凭证吗？")) {
        return;
      }
      setBusy(mode);
      setNotice(null);
      setErrorMessage(null);
      setOneTimeToken(null);
      try {
        const result = mode === "create" ? await createCredential() : await rotateCredential();
        setStatus({ status: "active", credential: result.credential });
        setOneTimeToken(result.token);
        setNotice(mode === "create" ? "接入凭证已生成。" : "凭证已轮换，旧凭证已经失效。");
      } catch {
        setErrorMessage(
          mode === "create"
            ? "生成凭证失败；如果已经有可用凭证，请刷新后选择轮换。"
            : "轮换失败，现有凭证状态未在本页改变。",
        );
      } finally {
        setBusy(null);
      }
    },
    [createCredential, rotateCredential],
  );

  const handleRevoke = async () => {
    if (!window.confirm("撤销后 WorkBuddy 将不能继续同步或读取导师回复。确认撤销吗？")) {
      return;
    }
    setBusy("revoke");
    setNotice(null);
    setErrorMessage(null);
    setOneTimeToken(null);
    try {
      const next = await revokeCredential();
      setStatus(next);
      setNotice("接入凭证已撤销，旧凭证现在无效。");
    } catch {
      setErrorMessage("撤销失败，请稍后重试。");
    } finally {
      setBusy(null);
    }
  };

  const copy = async (kind: "token" | "skill", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1_500);
    } catch {
      setCopied(null);
      setErrorMessage("复制失败，请使用系统复制命令。");
    }
  };

  const clearOneTimeMaterial = () => {
    setOneTimeToken(null);
    setCopied(null);
    setNotice("一次性凭证已从当前页面清除。");
  };

  const hasActive = status.status === "active";

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">WorkBuddy 一键接入</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              创建可随时撤销的学员专属凭证，并安装可靠同步 Skill。
            </p>
          </div>
          <Link to="/" className="rounded-md border px-3 py-2 text-sm">
            返回
          </Link>
        </header>

        <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <div className="font-medium">旧版 Skill 必须更新</div>
          <p className="mt-1 text-muted-foreground">
            如果已经安装过使用 session/items
            的旧版，请删除后重新安装本页生成的版本。轮换凭证后，旧版中的凭证会立即失效。
          </p>
        </section>

        {(notice || errorMessage) && (
          <div
            role="status"
            className={`rounded-lg border p-3 text-sm ${
              errorMessage
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-800"
            }`}
          >
            {errorMessage ?? notice}
          </div>
        )}

        <section className="rounded-lg border border-border bg-card p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="font-medium">接入凭证</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {loading
                  ? "正在读取状态…"
                  : hasActive
                    ? "当前有一个可用凭证"
                    : status.status === "revoked"
                      ? "最近的凭证已撤销"
                      : "尚未创建凭证"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {!hasActive && (
                <button
                  type="button"
                  disabled={loading || busy !== null}
                  onClick={() => void runIssue("create")}
                  className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50"
                >
                  {busy === "create" ? "生成中…" : "生成凭证"}
                </button>
              )}
              {hasActive && (
                <>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void runIssue("rotate")}
                    className="rounded-md border px-3 py-2 text-xs disabled:opacity-50"
                  >
                    {busy === "rotate" ? "轮换中…" : "轮换凭证"}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void handleRevoke()}
                    className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive disabled:opacity-50"
                  >
                    {busy === "revoke" ? "撤销中…" : "撤销凭证"}
                  </button>
                </>
              )}
            </div>
          </div>

          {status.credential && (
            <dl className="mt-4 grid gap-2 rounded-md bg-muted p-3 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">安全前缀</dt>
                <dd className="mt-1 font-mono">{status.credential.prefix}…</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">状态</dt>
                <dd className="mt-1">
                  {status.credential.status === "active" ? "可用" : "已撤销"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">最近使用</dt>
                <dd className="mt-1">{formatTimestamp(status.credential.last_used_at)}</dd>
              </div>
            </dl>
          )}
        </section>

        {oneTimeToken && skillMd ? (
          <>
            <section className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-medium">一次性接入凭证</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    仅显示这一次；刷新或离开本页后无法恢复。请立即复制完整 Skill，完成后清除。
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void copy("token", oneTimeToken)}
                    className="rounded-md border px-3 py-2 text-xs"
                  >
                    {copied === "token" ? "已复制" : "复制凭证"}
                  </button>
                  <button
                    type="button"
                    onClick={clearOneTimeMaterial}
                    className="rounded-md border px-3 py-2 text-xs"
                  >
                    清除
                  </button>
                </div>
              </div>
              <code className="mt-4 block overflow-x-auto rounded-md bg-background p-3 text-xs">
                {oneTimeToken}
              </code>
            </section>

            <section className="rounded-lg border border-border bg-card p-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="font-medium">可安装的新版 SKILL.md</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    已写入当前一次性凭证；复制后粘贴到 WorkBuddy 安装。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void copy("skill", skillMd)}
                  className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground"
                >
                  {copied === "skill" ? "已复制完整 Skill" : "复制完整 Skill"}
                </button>
              </div>
              <pre className="max-h-[520px] overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
                {skillMd}
              </pre>
            </section>
          </>
        ) : (
          <section className="rounded-lg border border-dashed border-border bg-card p-5 text-sm">
            <h2 className="font-medium">Skill 尚不可安装</h2>
            <p className="mt-1 text-muted-foreground">
              {hasActive
                ? "为保护凭证，完整内容不会再次显示。如尚未安装，请轮换一次并立即复制新 Skill。"
                : "先生成接入凭证，页面才会生成包含当前凭证的完整 Skill。"}
            </p>
          </section>
        )}

        <section className="rounded-lg border border-border bg-card p-4 text-sm">
          <div className="mb-2 font-medium">更新步骤</div>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>删除 WorkBuddy 中旧的 superbrain-sync Skill。</li>
            <li>生成或轮换凭证，并立即复制完整新版 Skill。</li>
            <li>安装后完成一轮对话；同一对话持续复用 source_session_key。</li>
          </ol>
        </section>
      </div>
    </main>
  );
}
