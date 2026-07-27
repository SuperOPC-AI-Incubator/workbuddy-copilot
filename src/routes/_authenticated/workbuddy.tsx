import { Link, createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";

import {
  createWorkbuddyCredential,
  getWorkbuddyCredentialStatus,
  revokeWorkbuddyCredential,
  rotateWorkbuddyCredential,
} from "@/lib/workbuddy/credentials.functions";
import { checkMcpReachability } from "@/lib/workbuddy/mcp-reachability";

export const Route = createFileRoute("/_authenticated/workbuddy")({
  component: WorkBuddySetup,
});

type CredentialStatus = Awaited<ReturnType<typeof getWorkbuddyCredentialStatus>>;
type PlatformTab = "macos" | "linux" | "windows";

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
  const [apiOrigin, setApiOrigin] = useState("https://<copilot-host>");
  const [platformTab, setPlatformTab] = useState<PlatformTab>("macos");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"create" | "rotate" | "revoke" | null>(null);
  const [mcpCheck, setMcpCheck] = useState<"idle" | "checking" | "reachable" | "failed">("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState<"token" | "command" | "mcp" | null>(null);

  useEffect(() => {
    setApiOrigin(window.location.origin);
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

  const copy = async (kind: "token" | "command" | "mcp", value: string) => {
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
  const mcpUrl = `${apiOrigin}/mcp`;
  const testMcpAddress = async () => {
    setMcpCheck("checking");
    const result = await checkMcpReachability(window.location.origin);
    setMcpCheck(result.status === "reachable" ? "reachable" : "failed");
  };
  const posixInstallCommand = `work_dir="$(mktemp -d)" && cd "$work_dir" && \\
curl -fsSLO "${apiOrigin}/downloads/workbuddy-sync.mjs" && \\
curl -fsSLO "${apiOrigin}/downloads/workbuddy-transcript.mjs" && \\
curl -fsSLO "${apiOrigin}/downloads/workbuddy-event-id.mjs" && \\
curl -fsSLO "${apiOrigin}/downloads/workbuddy-hook.mjs" && \\
curl -fsSLO "${apiOrigin}/downloads/detect-runtime.sh" && \\
curl -fsSLO "${apiOrigin}/downloads/SKILL.md" && \\
curl -fsSLO "${apiOrigin}/downloads/install-macos.sh" && \\
chmod 700 install-macos.sh && ./install-macos.sh --api-url "${apiOrigin}"`;
  const windowsInstallCommand = `$workDir = Join-Path ([IO.Path]::GetTempPath()) ("superbrain-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $workDir | Out-Null
Invoke-WebRequest "${apiOrigin}/downloads/workbuddy-sync.mjs" -OutFile (Join-Path $workDir "workbuddy-sync.mjs")
Invoke-WebRequest "${apiOrigin}/downloads/workbuddy-transcript.mjs" -OutFile (Join-Path $workDir "workbuddy-transcript.mjs")
Invoke-WebRequest "${apiOrigin}/downloads/workbuddy-event-id.mjs" -OutFile (Join-Path $workDir "workbuddy-event-id.mjs")
Invoke-WebRequest "${apiOrigin}/downloads/workbuddy-hook.mjs" -OutFile (Join-Path $workDir "workbuddy-hook.mjs")
Invoke-WebRequest "${apiOrigin}/downloads/SKILL.md" -OutFile (Join-Path $workDir "SKILL.md")
Invoke-WebRequest "${apiOrigin}/downloads/install-windows.ps1" -OutFile (Join-Path $workDir "install-windows.ps1")
& (Join-Path $workDir "install-windows.ps1") -ApiUrl "${apiOrigin}"`;
  const installCommand = platformTab === "windows" ? windowsInstallCommand : posixInstallCommand;
  const installedSkillPath =
    platformTab === "windows"
      ? "%USERPROFILE%\\.workbuddy\\skills\\superbrain-sync\\SKILL.md"
      : "$HOME/.workbuddy/skills/superbrain-sync/SKILL.md";
  const connectorCommand =
    platformTab === "windows"
      ? '& "$env:LOCALAPPDATA\\SuperBrainCopilot\\app\\workbuddy-sync.ps1"'
      : '"$HOME/.local/bin/workbuddy-sync"';

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">WorkBuddy 一键接入</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              优先使用 MCP；不支持 MCP 时安装可靠的跨平台同步连接器。
            </p>
          </div>
          <Link to="/" className="rounded-md border px-3 py-2 text-sm">
            返回
          </Link>
        </header>

        <section className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <div className="font-medium">旧版 Skill 必须更新</div>
          <p className="mt-1 text-muted-foreground">
            如果已经安装过使用 session/items 的旧版，请删除后重新接入。接入凭证不再写进
            Skill、命令或对话事件。
          </p>
        </section>

        <section className="rounded-lg border border-primary/40 bg-primary/5 p-5 text-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-medium">MCP 接入（推荐首选）</h2>
              <p className="mt-1 text-muted-foreground">
                如果 WorkBuddy 支持 MCP，请优先连接 SuperBrain
                MCP。它能直接完成同步、拉取导师消息和下一轮确认，无需安装后台任务。
              </p>
            </div>
            <span className="rounded-full bg-primary px-2.5 py-1 text-xs text-primary-foreground">
              推荐
            </span>
          </div>
          <div className="mt-4 rounded-md bg-background p-3">
            <div className="text-xs text-muted-foreground">MCP 地址</div>
            <code className="mt-1 block break-all text-xs">{mcpUrl}</code>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void copy("mcp", mcpUrl)}
                className="rounded-md border px-3 py-2 text-xs"
              >
                {copied === "mcp" ? "MCP 地址已复制" : "复制 MCP 地址"}
              </button>
              <button
                type="button"
                disabled={mcpCheck === "checking"}
                onClick={() => void testMcpAddress()}
                className="rounded-md border px-3 py-2 text-xs disabled:opacity-50"
              >
                {mcpCheck === "checking" ? "检查中…" : "测试 MCP 地址"}
              </button>
            </div>
            {mcpCheck !== "idle" && mcpCheck !== "checking" && (
              <p
                className={`mt-2 text-xs ${
                  mcpCheck === "reachable" ? "text-emerald-700" : "text-destructive"
                }`}
              >
                {mcpCheck === "reachable"
                  ? "MCP 端点可达，OAuth 尚待授权；这不是完整连接测试。"
                  : "MCP 元数据或端点不可访问，请检查网络和部署状态；404/服务错误不会判为成功。"}
              </p>
            )}
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
              <li>打开 WorkBuddy 设置中的 MCP / 工具连接页面。</li>
              <li>新增服务并粘贴上面的 MCP 地址。</li>
              <li>按浏览器提示登录并授权，再回到 WorkBuddy 完成一轮测试对话。</li>
            </ol>
          </div>
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

        {oneTimeToken ? (
          <section className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-medium">一次性接入凭证</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  仅显示这一次。先复制，然后在安装器出现遮罩输入提示时粘贴；不要把它写进命令、Skill
                  或事件文件。
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
        ) : (
          <section className="rounded-lg border border-dashed border-border bg-card p-5 text-sm">
            <h2 className="font-medium">准备一次性凭证</h2>
            <p className="mt-1 text-muted-foreground">
              {hasActive
                ? "凭证不会再次显示。如尚未完成安装，请轮换一次，再把新凭证粘贴到安装器的遮罩输入框。"
                : "先生成接入凭证，再运行下方安装命令。安装器会要求粘贴凭证。"}
            </p>
          </section>
        )}

        <section className="rounded-lg border border-border bg-card p-5 text-sm">
          <div>
            <h2 className="font-medium">不支持 MCP？安装本机连接器</h2>
            <p className="mt-1 text-muted-foreground">
              安装命令不含凭证。连接器使用当前用户私有目录、离线队列和定时任务，网络恢复后自动续传。
            </p>
          </div>

          <div className="mt-4 flex gap-2 border-b">
            {(
              [
                ["macos", "macOS"],
                ["linux", "Linux"],
                ["windows", "Windows"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setPlatformTab(value)}
                className={`border-b-2 px-3 py-2 text-xs ${
                  platformTab === value
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <a
              href="/downloads/workbuddy-sync.mjs"
              download
              className="rounded-md border px-3 py-2 text-xs"
            >
              下载 connector
            </a>
            <a
              href={
                platformTab === "windows"
                  ? "/downloads/install-windows.ps1"
                  : "/downloads/install-macos.sh"
              }
              download
              className="rounded-md border px-3 py-2 text-xs"
            >
              下载安装器
            </a>
            <a href="/downloads/SKILL.md" download className="rounded-md border px-3 py-2 text-xs">
              下载无凭证 Skill
            </a>
            <button
              type="button"
              onClick={() => void copy("command", installCommand)}
              className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground"
            >
              {copied === "command" ? "命令已复制" : "复制安装命令"}
            </button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            手动下载时，下面这些文件必须和安装器放在同一个目录：连接器和上行 hook
            在启动时就会加载它们，缺一个就会安装失败。
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {[
              "workbuddy-transcript.mjs",
              "workbuddy-event-id.mjs",
              "workbuddy-hook.mjs",
              ...(platformTab === "windows" ? [] : ["detect-runtime.sh"]),
            ].map((asset) => (
              <a
                key={asset}
                href={`/downloads/${asset}`}
                download
                className="rounded-md border px-2 py-1 font-mono text-xs"
              >
                {asset}
              </a>
            ))}
          </div>
          <pre className="mt-3 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
            {installCommand}
          </pre>
          <p className="mt-3 text-xs text-muted-foreground">
            运行后，在遮罩提示中粘贴上方一次性凭证。Windows 使用当前用户 ACL；macOS/Linux 使用 0700
            目录和 0600 配置，不需要管理员权限。
          </p>
          <div className="mt-3 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            <p>
              Skill 安装位置：<code>{installedSkillPath}</code>。安装完成后请重启 WorkBuddy。
            </p>
            <p className="mt-1">
              如果当前 WorkBuddy 版本没有自动扫描该目录，请打开“技能栏 → 导入”，手动选择这个
              SKILL.md。
            </p>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-4 text-sm">
          <div className="mb-2 font-medium">安装后检查</div>
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>
              运行 <code>{connectorCommand} status</code> 查看配置、队列和待确认数量。
            </li>
            <li>
              运行 <code>{connectorCommand} flush</code> 手动重试离线事件。
            </li>
            <li>
              运行 <code>{connectorCommand} test-connection</code> 验证本地 connector 的凭证与网络。
            </li>
            <li>
              <code>fetch</code> 只持久化并显示导师原文，不会自动 <code>ack</code>。
            </li>
          </ol>
        </section>
      </div>
    </main>
  );
}
