import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { KIND_META, SEVERITY_COLOR, formatTime, timeAgo } from "@/lib/timeline-meta";
import type { Severity, TimelineKind } from "@/lib/timeline-meta";
import { useServerFn } from "@tanstack/react-start";
import { askAI, draftMentorTip } from "@/lib/ai.functions";

export const Route = createFileRoute("/_authenticated/")({
  component: MentorDesk,
});

type Student = {
  id: string;
  display_name: string;
  last_severity: Severity;
  last_active_at: string;
};
type Session = {
  id: string;
  student_id: string;
  session_title: string;
  session_group: "space" | "task";
  last_severity: Severity;
  updated_at: string;
};
type TimelineItem = {
  id: string;
  session_id: string;
  kind: TimelineKind;
  text: string;
  severity: Severity | null;
  tag: string | null;
  author_id: string | null;
  created_at: string;
};

const toEpoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function MentorDesk() {
  const navigate = useNavigate();
  const [students, setStudents] = useState<Student[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [currentStudentId, setCurrentStudentId] = useState<string | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [composeText, setComposeText] = useState("");
  const [collapsed, setCollapsed] = useState({ space: false, task: false });
  const [wsConnected, setWsConnected] = useState(false);
  const [userEmail, setUserEmail] = useState<string>("");
  const [role, setRole] = useState<"mentor" | "student" | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const askAIFn = useServerFn(askAI);
  const draftFn = useServerFn(draftMentorTip);

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      setUserEmail(data.user?.email ?? "");
      if (!data.user) return;
      const { data: roles } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", data.user.id);
      const isMentor = roles?.some((r) => r.role === "mentor");
      setRole(isMentor ? "mentor" : "student");
    });
  }, []);

  // Mentor-wide alerts: SOS (call mentor) / error (AI severity=error) / warn (soft toast).
  type AlertKind = "sos" | "error" | "warn";
  type MentorAlert = {
    id: string;
    kind: AlertKind;
    fromWorkBuddy: boolean;
    studentName: string;
    text: string;
    sessionId: string;
    studentId: string;
  };
  const [alerts, setAlerts] = useState<MentorAlert[]>([]);
  useEffect(() => {
    if (role !== "mentor") return;
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    const ch = supabase
      .channel("mentor-alerts")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "timeline_items" },
        async (payload) => {
          const row = payload.new as TimelineItem;
          const tag = row.tag ?? "";
          const isSos = tag.includes("呼叫导师");
          const isError = row.kind === "diagnosis" && row.severity === "error" && !isSos;
          const isWarn = row.kind === "diagnosis" && row.severity === "warn";
          if (!isSos && !isError && !isWarn) return;
          const kind: AlertKind = isSos ? "sos" : isError ? "error" : "warn";
          const fromWorkBuddy = tag.startsWith("WB") || tag === "WorkBuddy";
          // Look up student name via session
          const { data: sess } = await supabase
            .from("sessions")
            .select("student_id, students(display_name)")
            .eq("id", row.session_id)
            .single();
          const studentId = (sess as { student_id?: string } | null)?.student_id ?? "";
          const studentName =
            (sess as { students?: { display_name?: string } } | null)?.students?.display_name ?? "学员";
          const alertId = row.id;
          setAlerts((prev) => [
            { id: alertId, kind, fromWorkBuddy, studentName, text: row.text, sessionId: row.session_id, studentId },
            ...prev,
          ].slice(0, 5));
          // Warn: soft toast, auto-dismiss, no sound / notification / title flash.
          if (kind === "warn") {
            window.setTimeout(() => {
              setAlerts((prev) => prev.filter((a) => a.id !== alertId));
            }, 6000);
            return;
          }
          // Sound (sos = double chime, error = single).
          try {
            const AudioCtx =
              (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
                .AudioContext ??
              (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (AudioCtx) {
              const ctx = new AudioCtx();
              const play = (freq: number, start: number, dur = 0.18) => {
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.type = "sine";
                o.frequency.value = freq;
                g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
                g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + start + 0.02);
                g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + dur);
                o.connect(g).connect(ctx.destination);
                o.start(ctx.currentTime + start);
                o.stop(ctx.currentTime + start + dur + 0.02);
              };
              if (kind === "sos") {
                play(880, 0);
                play(1175, 0.2);
              } else {
                play(720, 0, 0.22);
              }
            }
          } catch {
            /* noop */
          }
          const title =
            kind === "sos"
              ? `🆘 ${studentName} 呼叫导师`
              : `⚠️ ${studentName} 需导师介入`;
          // Browser Notification
          if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
            try {
              const n = new Notification(title, {
                body: row.text,
                tag: `mentor-${alertId}`,
                requireInteraction: kind === "sos",
              });
              n.onclick = () => {
                window.focus();
                setCurrentStudentId(studentId);
                setCurrentSessionId(row.session_id);
                n.close();
              };
            } catch {
              /* noop */
            }
          }
          // Title flash (sos only, keeps chrome quieter for AI-flagged errors).
          if (kind !== "sos") return;
          const original = document.title;
          let toggle = false;
          const iv = window.setInterval(() => {
            document.title = (toggle = !toggle) ? `🆘 ${studentName} 呼叫中…` : original;
          }, 1000);
          window.setTimeout(() => {
            window.clearInterval(iv);
            document.title = original;
          }, 8000);
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [role]);

  const dismissAlert = (id: string) => setAlerts((prev) => prev.filter((a) => a.id !== id));
  const jumpToAlert = (a: { id: string; sessionId: string; studentId: string }) => {
    setCurrentStudentId(a.studentId);
    setCurrentSessionId(a.sessionId);
    dismissAlert(a.id);
  };

  // Initial load + realtime for students
  useEffect(() => {
    let mounted = true;
    supabase
      .from("students")
      .select("*")
      .order("last_active_at", { ascending: false })
      .then(({ data }) => {
        if (!mounted || !data) return;
        setStudents(data as Student[]);
        if (data[0] && !currentStudentId) setCurrentStudentId(data[0].id);
      });

    const ch = supabase
      .channel("students-rt")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "students" },
        (payload) => {
          setStudents((prev) => applyChange(prev, payload, (a, b) =>
            new Date(b.last_active_at).getTime() - new Date(a.last_active_at).getTime(),
          ));
        },
      )
      .subscribe((status) => setWsConnected(status === "SUBSCRIBED"));
    return () => {
      mounted = false;
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sessions for current student + realtime
  useEffect(() => {
    if (!currentStudentId) {
      setSessions([]);
      return;
    }
    let mounted = true;
    supabase
      .from("sessions")
      .select("*")
      .eq("student_id", currentStudentId)
      .order("updated_at", { ascending: false })
      .then(({ data }) => {
        if (!mounted || !data) return;
        setSessions(data as Session[]);
        if (!currentSessionId || !data.some((s) => s.id === currentSessionId)) {
          setCurrentSessionId(data[0]?.id ?? null);
        }
      });

    const ch = supabase
      .channel(`sessions-rt-${currentStudentId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "sessions",
          filter: `student_id=eq.${currentStudentId}`,
        },
        (payload) => {
          setSessions((prev) =>
            applyChange(prev, payload, (a, b) =>
              new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
            ),
          );
        },
      )
      .subscribe();
    return () => {
      mounted = false;
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStudentId]);

  // Timeline for current session + realtime
  useEffect(() => {
    if (!currentSessionId) {
      setTimeline([]);
      return;
    }
    let mounted = true;
    supabase
      .from("timeline_items")
      .select("*")
      .eq("session_id", currentSessionId)
      .order("created_at", { ascending: true })
      .then(({ data }) => {
        if (!mounted || !data) return;
        setTimeline(data as TimelineItem[]);
      });

    const ch = supabase
      .channel(`timeline-rt-${currentSessionId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "timeline_items",
          filter: `session_id=eq.${currentSessionId}`,
        },
        (payload) => {
          setTimeline((prev) =>
            applyChange(prev, payload, (a, b) =>
              new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
            ),
          );
        },
      )
      .subscribe();
    return () => {
      mounted = false;
      supabase.removeChannel(ch);
    };
  }, [currentSessionId]);

  const currentStudent = students.find((s) => s.id === currentStudentId) ?? null;
  const currentSession = sessions.find((s) => s.id === currentSessionId) ?? null;

  const selectStudent = (id: string) => {
    setCurrentStudentId(id);
    setCurrentSessionId(null);
  };

  const sendMentor = async (e: FormEvent) => {
    e.preventDefault();
    const text = composeText.trim();
    if (!text || !currentSessionId) return;
    setComposeText("");
    const { data: userRes } = await supabase.auth.getUser();
    const { error } = await supabase.from("timeline_items").insert({
      session_id: currentSessionId,
      kind: "mentor",
      text,
      author_id: userRes.user?.id ?? null,
    });
    if (error) {
      console.error(error);
      setComposeText(text);
    }
  };

  const sendStudentPrompt = async (e: FormEvent) => {
    e.preventDefault();
    const text = composeText.trim();
    if (!text || !currentSessionId || aiBusy) return;
    setComposeText("");
    setAiBusy(true);
    try {
      await askAIFn({ data: { sessionId: currentSessionId, prompt: text } });
    } catch (err) {
      console.error(err);
      setComposeText(text);
      alert("AI 请求失败：" + (err as Error).message);
    } finally {
      setAiBusy(false);
    }
  };

  const draftTip = async () => {
    if (!currentSessionId || aiBusy) return;
    setAiBusy(true);
    try {
      const { draft } = await draftFn({ data: { sessionId: currentSessionId } });
      if (draft) setComposeText(draft);
    } catch (err) {
      console.error(err);
      alert("草稿生成失败：" + (err as Error).message);
    } finally {
      setAiBusy(false);
    }
  };

  const callMentor = async () => {
    if (role !== "student" || !currentSessionId || aiBusy) return;
    const note = window.prompt("向导师说明一下情况（可留空）：", "") ?? "";
    const text = note.trim()
      ? `🆘 呼叫导师：${note.trim()}`
      : "🆘 学员请求导师协助";
    const { data: userRes } = await supabase.auth.getUser();
    const { error } = await supabase.from("timeline_items").insert({
      session_id: currentSessionId,
      kind: "diagnosis",
      text,
      severity: "error",
      tag: "呼叫导师",
      author_id: userRes.user?.id ?? null,
    });
    if (error) alert("呼叫失败：" + error.message);
  };

  const createSession = async () => {
    if (role !== "student" || !currentStudentId) return;
    const title = prompt("新对话标题？", "PLC 学习会话");
    if (!title) return;
    const { data, error } = await supabase
      .from("sessions")
      .insert({ student_id: currentStudentId, session_title: title, session_group: "task" })
      .select()
      .single();
    if (error) {
      alert("创建失败：" + error.message);
      return;
    }
    if (data) setCurrentSessionId(data.id);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <TopBar
        studentCount={students.length}
        activeStudent={currentStudent}
        wsConnected={wsConnected}
        userEmail={userEmail}
        onSignOut={signOut}
      />
      {role === "mentor" && alerts.length > 0 && (
        <div className="pointer-events-none fixed right-4 top-16 z-50 flex w-80 flex-col gap-2">
          {alerts.map((a) => (
            <div
              key={a.id}
              className="pointer-events-auto animate-in slide-in-from-right rounded-lg border border-red-500/40 bg-red-600 p-3 text-white shadow-xl"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <div className="text-sm font-semibold">🆘 {a.studentName} 呼叫导师</div>
                  <div className="mt-1 text-xs text-white/90 line-clamp-3">{a.text}</div>
                </div>
                <button
                  type="button"
                  onClick={() => dismissAlert(a.id)}
                  className="text-white/70 hover:text-white"
                  aria-label="关闭"
                >
                  ✕
                </button>
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => jumpToAlert(a)}
                  className="rounded-md bg-white/20 px-2.5 py-1 text-xs font-medium hover:bg-white/30"
                >
                  查看会话
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <main className="grid min-h-0 flex-1 grid-cols-[280px_320px_1fr]">
        <StudentPanel
          students={students}
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
          canCreate={role === "student" && !!currentStudentId}
          onCreate={createSession}
        />
        <TimelinePanel
          items={timeline}
          student={currentStudent}
          session={currentSession}
          composeText={composeText}
          onComposeChange={setComposeText}
          onSend={role === "student" ? sendStudentPrompt : sendMentor}
          role={role}
          aiBusy={aiBusy}
          onDraftTip={draftTip}
          onCallMentor={callMentor}
        />
      </main>
    </div>
  );
}

function applyChange<T extends { id: string }>(
  prev: T[],
  payload: { eventType: string; new: unknown; old: unknown },
  sortFn: (a: T, b: T) => number,
): T[] {
  if (payload.eventType === "INSERT") {
    const row = payload.new as T;
    if (prev.some((p) => p.id === row.id)) return prev;
    return [...prev, row].sort(sortFn);
  }
  if (payload.eventType === "UPDATE") {
    const row = payload.new as T;
    return prev.map((p) => (p.id === row.id ? row : p)).sort(sortFn);
  }
  if (payload.eventType === "DELETE") {
    const row = payload.old as T;
    return prev.filter((p) => p.id !== row.id);
  }
  return prev;
}

/* ─── Top Bar ───────────────────────────────────────────── */
function TopBar({
  studentCount,
  activeStudent,
  wsConnected,
  userEmail,
  onSignOut,
}: {
  studentCount: number;
  activeStudent: Student | null;
  wsConnected: boolean;
  userEmail: string;
  onSignOut: () => void;
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
          <h1 className="text-sm font-semibold tracking-wide">WorkBuddy Copilot</h1>
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
            style={{ background: wsConnected ? "var(--status-green)" : "var(--status-yellow)" }}
          />
          <span style={{ color: "var(--sidebar-fg)" }}>
            {wsConnected ? "Realtime 已连接" : "连接中…"}
          </span>
        </span>
        {userEmail && (
          <span style={{ color: "var(--sidebar-muted)" }} className="hidden md:inline">
            {userEmail}
          </span>
        )}
        <button
          type="button"
          onClick={onSignOut}
          className="rounded-md border px-2.5 py-1 text-xs transition-colors"
          style={{
            borderColor: "oklch(1 0 0 / 0.15)",
            color: "var(--sidebar-fg)",
          }}
        >
          退出
        </button>
      </div>
    </header>
  );
}

/* ─── Student Panel ─────────────────────────────────────── */
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
        {students.length === 0 && (
          <li className="px-3 py-6 text-center text-xs" style={{ color: "var(--sidebar-muted)" }}>
            暂无学员
          </li>
        )}
        {students.map((s) => {
          const active = s.id === currentId;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors"
                style={{ background: active ? "var(--sidebar-active)" : "transparent" }}
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
                    {timeAgo(toEpoch(s.last_active_at))}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

/* ─── Session Panel ─────────────────────────────────────── */
function SessionPanel({
  sessions,
  currentId,
  collapsed,
  onToggle,
  onSelect,
  student,
  canCreate,
  onCreate,
}: {
  sessions: Session[];
  currentId: string | null;
  collapsed: { space: boolean; task: boolean };
  onToggle: (g: "space" | "task") => void;
  onSelect: (id: string) => void;
  student: Student | null;
  canCreate?: boolean;
  onCreate?: () => void;
}) {
  const grouped = useMemo(
    () => ({
      task: sessions.filter((s) => s.session_group === "task"),
      space: sessions.filter((s) => s.session_group === "space"),
    }),
    [sessions],
  );

  return (
    <section className="flex min-h-0 flex-col border-r bg-card">
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span>对话 · {sessions.length}</span>
        {canCreate && (
          <button
            type="button"
            onClick={onCreate}
            className="rounded border px-2 py-0.5 text-[11px] normal-case tracking-normal hover:bg-accent"
          >
            + 新对话
          </button>
        )}
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
            const active = s.id === currentId;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
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
                    <span>{timeAgo(toEpoch(s.updated_at))}</span>
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

/* ─── Timeline Panel ────────────────────────────────────── */
function TimelinePanel({
  items,
  student,
  session,
  composeText,
  onComposeChange,
  onSend,
  role,
  aiBusy,
  onDraftTip,
  onCallMentor,
}: {
  items: TimelineItem[];
  student: Student | null;
  session: Session | null;
  composeText: string;
  onComposeChange: (v: string) => void;
  onSend: (e: FormEvent) => void;
  role: "mentor" | "student" | null;
  aiBusy: boolean;
  onDraftTip: () => void;
  onCallMentor: () => void;
}) {
  const isStudent = role === "student";
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
            disabled={!session || aiBusy}
            placeholder={
              !session
                ? "选中对话后可发送…"
                : isStudent
                  ? "向 AI 提问 PLC 相关问题…"
                  : `向 ${student?.display_name ?? "学员"} 发送导师提示…`
            }
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary disabled:cursor-not-allowed disabled:opacity-50"
          />
          {role === "mentor" && (
            <button
              type="button"
              onClick={onDraftTip}
              disabled={!session || aiBusy}
              className="rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              title="用 AI 起草一条导师提示"
            >
              {aiBusy ? "生成中…" : "AI 起草"}
            </button>
          )}
          {isStudent && (
            <button
              type="button"
              onClick={onCallMentor}
              disabled={!session || aiBusy}
              className="rounded-md border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                borderColor: "var(--status-red)",
                color: "var(--status-red)",
              }}
              title="向导师发出紧急协助请求"
            >
              🆘 呼叫导师
            </button>
          )}
          <button
            type="submit"
            disabled={!session || !composeText.trim() || aiBusy}
            className="rounded-md px-4 py-2 text-sm font-medium transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
          >
            {isStudent ? (aiBusy ? "AI 回答中…" : "提问") : "发送"}
          </button>
        </form>
        <Legend />
      </div>
    </section>
  );
}

function TimelineCard({ item }: { item: TimelineItem }) {
  const meta = KIND_META[item.kind];
  const ts = toEpoch(item.created_at);
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
          <time className="text-muted-foreground">{formatTime(ts)}</time>
        </header>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {item.text}
        </p>
      </article>
    </li>
  );
}

/* ─── Bits ──────────────────────────────────────────────── */
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
  const label: Record<Severity, string> = { ok: "正常", warn: "注意", error: "紧急" };
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