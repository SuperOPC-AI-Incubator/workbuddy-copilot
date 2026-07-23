// Timeline display metadata and formatting helpers.
// All data comes from Supabase; nothing mock lives here.

export type Severity = "ok" | "warn" | "error";
export type TimelineKind = "prompt" | "reply" | "diagnosis" | "mentor";

export function formatTime(ts: number | string): string {
  const ms = typeof ts === "string" ? new Date(ts).getTime() : ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(ts: number | string): string {
  const sec =
    typeof ts === "string"
      ? Math.floor(new Date(ts).getTime() / 1000)
      : ts > 1e12
        ? Math.floor(ts / 1000)
        : ts;
  const diff = Math.max(1, Math.floor(Date.now() / 1000 - sec));
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

export const KIND_META: Record<
  TimelineKind,
  { label: string; bg: string; border: string; dot: string }
> = {
  prompt: {
    label: "学员提问",
    bg: "var(--msg-prompt)",
    border: "var(--msg-prompt-border)",
    dot: "var(--accent-amber)",
  },
  reply: {
    label: "AI 回复",
    bg: "var(--msg-reply)",
    border: "var(--msg-reply-border)",
    dot: "var(--status-green)",
  },
  diagnosis: {
    label: "学习诊断",
    bg: "var(--msg-diag)",
    border: "var(--msg-diag-border)",
    dot: "var(--primary)",
  },
  mentor: {
    label: "导师提示",
    bg: "var(--msg-mentor)",
    border: "var(--msg-mentor-border)",
    dot: "oklch(0.65 0.18 340)",
  },
};

export const SEVERITY_COLOR: Record<Severity, string> = {
  ok: "var(--status-green)",
  warn: "var(--status-yellow)",
  error: "var(--status-red)",
};
