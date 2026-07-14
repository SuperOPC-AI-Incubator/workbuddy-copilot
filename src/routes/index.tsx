import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  KIND_META,
  SEVERITY_COLOR,
  formatTime,
  mockStudents,
  sessionsFor,
  timeAgo,
  timelineFor,
  type Session,
  type Severity,
  type Student,
  type TimelineItem,
  type TimelineKind,
} from "@/lib/mock-data";

export const Route = createFileRoute("/")({
  component: MentorDesk,
});

function MentorDesk() {
  const [currentStudentId, setCurrentStudentId] = useState<string | null>(
    mockStudents[0]?.student_id ?? null,
  );
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(
    "s_1001",
  );
  const [outbound, setOutbound] = useState<TimelineItem[]>([]);
  const [composeText, setComposeText] = useState("");
  const [collapsed, setCollapsed] = useState<{ space: boolean; task: boolean }>({
    space: false,
    task: false,
  });

  const sessions = useMemo(() => sessionsFor(currentStudentId), [currentStudentId]);
  const baseTimeline = useMemo(() => timelineFor(currentSessionId), [currentSessionId]);
  const timeline = useMemo(
    () => [...baseTimeline, ...outbound].sort((a, b) => a.created_at - b.created_at),
    [baseTimeline, outbound],
  );

  const currentStudent = mockStudents.find((s) => s.student_id === currentStudentId) ?? null;
  const currentSession = sessions.find((s) => s.session_id === currentSessionId) ?? null;

  const selectStudent = (id: string) => {
    setCurrentStudentId(id);
    const first = sessionsFor(id)[0];
    setCurrentSessionId(first?.session_id ?? null);
    setOutbound([]);
  };

  const sendMentor = (e: React.FormEvent) => {
    e.preventDefault();
    const text = composeText.trim();
    if (!text || !currentStudentId) return;
    setOutbound((prev) => [
      ...prev,
      {
        id: `m_${Date.now()}`,
        kind: "mentor",
        text,
        created_at: Math.floor(Date.now() / 1000),
      },
    ]);
    setComposeText("");
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <TopBar
        studentCount={mockStudents.length}
        activeStudent={currentStudent}
      />
      <main className="grid min-h-0 flex-1 grid-cols-[280px_320px_1fr]">
        <StudentPanel
          students={mockStudents}
          currentId={currentStudentId}
          onSelect={selectStudent}
        />
        <SessionPanel
          sessions={sessions}
          currentId={currentSessionId}
          collapsed={collapsed}
          onToggle={(g) => setCollapsed((c) => ({ ...c, [g]: !c[g] }))}
          onSelect={setCurrentSessionId}
          student={currentStudent}
        />
        <TimelinePanel
          items={timeline}
          student={currentStudent}
          session={currentSession}
          composeText={composeText}
          onComposeChange={setComposeText}
          onSend={sendMentor}
        />
      </main>
    </div>
  );
}

/* ─── Top Bar ─────────────────────────────────────────────── */
function TopBar({
  studentCount,
  activeStudent,
}: {
  studentCount: number;
  activeStudent: Student | null;
}) {
  return (
    <header
      className="flex h-14 shrink-0 items-center justify-between border-b px-6"
      style={{ background: "var(--sidebar-bg)", color: "var(--sidebar-fg)" }}
    >
      <div className="flex items-center gap-3">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-md font-bold"
          style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
        >
          W
        </div>
        <div className="flex flex-col leading-tight">
          <h1 className="text-sm font-semibold tracking-wide">
            WorkBuddy Copilot
          </h1>
          <span className="text-[11px]" style={{ color: "var(--sidebar-muted)" }}>
            导师观察台 · PLC 实时学习辅助
          </span>
        </div>
      </div>
      <div className="flex items-center gap-4 text-xs">
        <span style={{ color: "var(--sidebar-muted)" }}>
          在线学员 <b style={{ color: "var(--sidebar-fg)" }}>{studentCount}</b>
        </span>
        {activeStudent && (
          <span style={{ color: "var(--sidebar-muted)" }}>
            当前 <b style={{ color: "var(--sidebar-fg)" }}>{activeStudent.display_name}</b>
          </span>
        )}
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1"
          style={{ background: "var(--sidebar-active)" }}
        >
          <span
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
            style={{ background: "var(--status-green)" }}
          />
          <span style={{ color: "var(--sidebar-fg)" }}>WS 已连接</span>
        </span>
      </div>
    </header>
  );
}

/* ─── Student Panel ──────────────────────────────────────── */
function StudentPanel({
  students,
  currentId,
  onSelect,
}: {
  students: Student[];
  currentId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <aside
      className="flex min-h-0 flex-col border-r"
      style={{ background: "var(--sidebar-bg)", color: "var(--sidebar-fg)" }}
    >
      <PanelHeader title="学员" count={students.length} dark />
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-4">
        {students.map((s) => {
          const active = s.student_id === currentId;
          return (
            <li key={s.student_id}>
              <button
                type="button"
                onClick={() => onSelect(s.student_id)}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors"
                style={{
                  background: active ? "var(--sidebar-active)" : "transparent",
                }}
              >
                <StatusDot severity={s.last_severity} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span
                    className="truncate text-sm font-medium"
                    style={{ color: "var(--sidebar-fg)" }}
                  >
                    {s.display_name}
                  </span>
                  <span
                    className="truncate text-[11px]"
                    style={{ color: "var(--sidebar-muted)" }}
                  >
                    {s.session_count} 对话 · {s.analysis_count} 分析 · {timeAgo(s.last_active_at)}
                  </span>
                </div>
                {s.alert_count > 0 && (
                  <span
                    className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{
                      background: "var(--status-red)",
                      color: "white",
                    }}
                  >
                    {s.alert_count}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

/* ─── Session Panel ──────────────────────────────────────── */
function SessionPanel({
  sessions,
  currentId,
  collapsed,
  onToggle,
  onSelect,
  student,
}: {
  sessions: Session[];
  currentId: string | null;
  collapsed: { space: boolean; task: boolean };
  onToggle: (g: "space" | "task") => void;
  onSelect: (id: string) => void;
  student: Student | null;
}) {
  const grouped = useMemo(() => {
    return {
      task: sessions.filter((s) => s.group === "task"),
      space: sessions.filter((s) => s.group === "space"),
    };
  }, [sessions]);

  return (
    <section className="flex min-h-0 flex-col border-r bg-card">
      <PanelHeader title="对话" count={sessions.length} />
      <div className="border-b bg-muted/40 px-4 py-2">
        <button
          type="button"
          disabled={!student}
          className="w-full rounded-md border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          ⟳ 同步该学员全部对话
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <EmptyState text={student ? "该学员暂无对话" : "请先选择一个学员"} />
        ) : (
          <>
            <SessionGroup
              title="任务"
              items={grouped.task}
              collapsed={collapsed.task}
              onToggle={() => onToggle("task")}
              currentId={currentId}
              onSelect={onSelect}
            />
            <SessionGroup
              title="空间"
              items={grouped.space}
              collapsed={collapsed.space}
              onToggle={() => onToggle("space")}
              currentId={currentId}
              onSelect={onSelect}
            />
          </>
        )}
      </div>
    </section>
  );
}

function SessionGroup({
  title,
  items,
  collapsed,
  onToggle,
  currentId,
  onSelect,
}: {
  title: string;
  items: Session[];
  collapsed: boolean;
  onToggle: () => void;
  currentId: string | null;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted/50"
      >
        <span>
          {title} · {items.length}
        </span>
        <span className="text-sm">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <ul>
          {items.map((s) => {
            const active = s.session_id === currentId;
            return (
              <li key={s.session_id}>
                <button
                  type="button"
                  onClick={() => onSelect(s.session_id)}
                  className="flex w-full flex-col gap-1 border-l-2 px-4 py-2.5 text-left transition-colors"
                  style={{
                    borderLeftColor: active ? "var(--primary)" : "transparent",
                    background: active ? "var(--accent)" : "transparent",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <StatusDot severity={s.last_severity} />
                    <span className="truncate text-sm font-medium text-foreground">
                      {s.session_title}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 pl-4 text-[11px] text-muted-foreground">
                    <span>{s.analysis_count} 分析</span>
                    {s.alert_count > 0 && (
                      <span style={{ color: "var(--status-red)" }}>
                        {s.alert_count} 告警
                      </span>
                    )}
                    <span>{timeAgo(s.updated_at)}</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ─── Timeline Panel ─────────────────────────────────────── */
function TimelinePanel({
  items,
  student,
  session,
  composeText,
  onComposeChange,
  onSend,
}: {
  items: TimelineItem[];
  student: Student | null;
  session: Session | null;
  composeText: string;
  onComposeChange: (v: string) => void;
  onSend: (e: React.FormEvent) => void;
}) {
  return (
    <section className="flex min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-start justify-between border-b bg-card px-6 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">
            {session?.session_title ?? "选择对话查看时间线"}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {student ? `${student.display_name} · ` : ""}
            {session ? `${items.length} 条事件` : "—"}
          </p>
        </div>
        {session && (
          <details className="text-xs">
            <summary className="cursor-pointer rounded border bg-background px-2.5 py-1 hover:bg-accent">
              查看完整对话原文
            </summary>
            <div className="mt-2 max-w-md rounded border bg-muted/50 p-3 text-xs text-muted-foreground">
              懒加载入口（mock）：真实环境下向 <code>/api/mentor/sessions/&#123;id&#125;/transcript</code> 请求。
            </div>
          </details>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {items.length === 0 ? (
          <EmptyState text="暂无事件" />
        ) : (
          <ol className="relative space-y-3 border-l-2 border-border pl-6">
            {items.map((item) => (
              <TimelineCard key={item.id} item={item} />
            ))}
          </ol>
        )}
      </div>

      <div className="shrink-0 border-t bg-card px-6 py-3">
        <form onSubmit={onSend} className="flex items-center gap-2">
          <input
            type="text"
            value={composeText}
            onChange={(e) => onComposeChange(e.target.value)}
            disabled={!student}
            placeholder={
              student
                ? `向 ${student.display_name} 发送提示（不改 AI，仅提示学员）…`
                : "选中学员后可发送提示…"
            }
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!student || !composeText.trim()}
            className="rounded-md px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              background: "var(--primary)",
              color: "var(--primary-foreground)",
            }}
          >
            发送
          </button>
        </form>
        <Legend />
      </div>
    </section>
  );
}

function TimelineCard({ item }: { item: TimelineItem }) {
  const meta = KIND_META[item.kind];
  return (
    <li className="relative">
      <span
        className="absolute -left-[29px] top-3 h-3 w-3 rounded-full ring-4 ring-background"
        style={{ background: meta.dot }}
      />
      <article
        className="rounded-lg border p-3.5 shadow-sm"
        style={{ background: meta.bg, borderColor: meta.border }}
      >
        <header className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground">{meta.label}</span>
            {item.tag && (
              <span
                className="rounded-full border px-1.5 py-0.5"
                style={{ borderColor: meta.border, color: "var(--foreground)" }}
              >
                {item.tag}
              </span>
            )}
            {item.severity && item.kind === "diagnosis" && (
              <SeverityBadge severity={item.severity} />
            )}
          </div>
          <time className="text-muted-foreground" dateTime={String(item.created_at)}>
            {formatTime(item.created_at)}
          </time>
        </header>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {item.text}
        </p>
      </article>
    </li>
  );
}

/* ─── Bits ───────────────────────────────────────────────── */
function PanelHeader({
  title,
  count,
  dark,
}: {
  title: string;
  count?: number;
  dark?: boolean;
}) {
  return (
    <div
      className="flex h-11 shrink-0 items-center justify-between border-b px-4 text-xs font-semibold uppercase tracking-wider"
      style={{
        color: dark ? "var(--sidebar-muted)" : "var(--muted-foreground)",
        borderColor: dark ? "oklch(1 0 0 / 0.08)" : "var(--border)",
      }}
    >
      <span>{title}</span>
      {typeof count === "number" && <span>{count}</span>}
    </div>
  );
}

function StatusDot({ severity }: { severity: Severity }) {
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: SEVERITY_COLOR[severity] }}
      aria-label={severity}
    />
  );
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const label: Record<Severity, string> = {
    ok: "正常",
    warn: "注意",
    error: "紧急",
  };
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
      style={{ background: SEVERITY_COLOR[severity] }}
    >
      {label[severity]}
    </span>
  );
}

function Legend() {
  const kinds: TimelineKind[] = ["prompt", "reply", "diagnosis", "mentor"];
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
      {kinds.map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 rounded-sm border"
            style={{ background: KIND_META[k].bg, borderColor: KIND_META[k].border }}
          />
          {KIND_META[k].label}
        </span>
      ))}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}
