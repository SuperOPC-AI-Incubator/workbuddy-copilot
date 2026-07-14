// Mock data reproducing the shape of workbuddy-copilot mentor APIs.
// Source of truth for the frontend replica; swap with real fetch calls later.

export type Severity = "ok" | "warn" | "error";

export interface Student {
  student_id: string;
  display_name: string;
  last_severity: Severity;
  session_count: number;
  analysis_count: number;
  alert_count: number;
  last_active_at: number; // unix seconds
}

export interface Session {
  session_id: string;
  session_title: string;
  group: "space" | "task";
  last_severity: Severity;
  analysis_count: number;
  alert_count: number;
  updated_at: number;
}

export type TimelineKind = "prompt" | "reply" | "diagnosis" | "mentor";

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  text: string;
  created_at: number;
  severity?: Severity;
  tag?: string;
}

const now = Math.floor(Date.now() / 1000);
const mins = (n: number) => now - n * 60;

export const mockStudents: Student[] = [
  {
    student_id: "stu_001",
    display_name: "陈子墨",
    last_severity: "warn",
    session_count: 4,
    analysis_count: 12,
    alert_count: 2,
    last_active_at: mins(2),
  },
  {
    student_id: "stu_002",
    display_name: "李澜舟",
    last_severity: "error",
    session_count: 3,
    analysis_count: 9,
    alert_count: 5,
    last_active_at: mins(1),
  },
  {
    student_id: "stu_003",
    display_name: "王思远",
    last_severity: "ok",
    session_count: 6,
    analysis_count: 18,
    alert_count: 0,
    last_active_at: mins(6),
  },
  {
    student_id: "stu_004",
    display_name: "赵一凡",
    last_severity: "ok",
    session_count: 2,
    analysis_count: 4,
    alert_count: 0,
    last_active_at: mins(22),
  },
  {
    student_id: "stu_005",
    display_name: "刘明轩",
    last_severity: "warn",
    session_count: 5,
    analysis_count: 14,
    alert_count: 1,
    last_active_at: mins(11),
  },
];

export const mockSessions: Record<string, Session[]> = {
  stu_001: [
    {
      session_id: "s_1001",
      session_title: "梯形图 · 电机启停互锁",
      group: "task",
      last_severity: "warn",
      analysis_count: 5,
      alert_count: 1,
      updated_at: mins(2),
    },
    {
      session_id: "s_1002",
      session_title: "SFC · 分度盘顺控",
      group: "task",
      last_severity: "ok",
      analysis_count: 3,
      alert_count: 0,
      updated_at: mins(38),
    },
    {
      session_id: "s_1003",
      session_title: "PLC 基础问答",
      group: "space",
      last_severity: "ok",
      analysis_count: 4,
      alert_count: 1,
      updated_at: mins(120),
    },
  ],
  stu_002: [
    {
      session_id: "s_2001",
      session_title: "ST · 温度 PID 调参",
      group: "task",
      last_severity: "error",
      analysis_count: 6,
      alert_count: 3,
      updated_at: mins(1),
    },
    {
      session_id: "s_2002",
      session_title: "FB 复用与作用域",
      group: "space",
      last_severity: "warn",
      analysis_count: 3,
      alert_count: 2,
      updated_at: mins(45),
    },
  ],
  stu_003: [
    {
      session_id: "s_3001",
      session_title: "IEC 61131-3 数据类型",
      group: "space",
      last_severity: "ok",
      analysis_count: 6,
      alert_count: 0,
      updated_at: mins(6),
    },
    {
      session_id: "s_3002",
      session_title: "传送带分拣控制流程",
      group: "task",
      last_severity: "ok",
      analysis_count: 8,
      alert_count: 0,
      updated_at: mins(30),
    },
  ],
  stu_004: [
    {
      session_id: "s_4001",
      session_title: "初识西门子 TIA Portal",
      group: "space",
      last_severity: "ok",
      analysis_count: 4,
      alert_count: 0,
      updated_at: mins(22),
    },
  ],
  stu_005: [
    {
      session_id: "s_5001",
      session_title: "急停回路安全设计",
      group: "task",
      last_severity: "warn",
      analysis_count: 7,
      alert_count: 1,
      updated_at: mins(11),
    },
    {
      session_id: "s_5002",
      session_title: "指令表 IL 语法练习",
      group: "space",
      last_severity: "ok",
      analysis_count: 5,
      alert_count: 0,
      updated_at: mins(80),
    },
  ],
};

export const mockTimeline: Record<string, TimelineItem[]> = {
  s_1001: [
    {
      id: "t1",
      kind: "prompt",
      text: "老师，我用 SET/RESET 做电机启停互锁，按启动键后停止键按下没反应，是不是扫描周期的问题？",
      created_at: mins(14),
    },
    {
      id: "t2",
      kind: "reply",
      text: "SET/RESET 组合优先级取决于程序段的先后。建议改用自保持回路（Start ANDN Stop OR Q），把 Stop 放在与门前。",
      created_at: mins(13),
    },
    {
      id: "t3",
      kind: "diagnosis",
      text: "学员对『扫描周期 vs 逻辑优先级』概念混淆，倾向归因到硬件层。建议引导画一次一个扫描周期的信号时序图。",
      created_at: mins(12),
      severity: "warn",
      tag: "概念混淆",
    },
    {
      id: "t4",
      kind: "prompt",
      text: "改成自保持后 Stop 有效了，但 Start 松开后马上又断开是为什么？",
      created_at: mins(6),
    },
    {
      id: "t5",
      kind: "reply",
      text: "自保持支路少写了 Q 常开触点。加上后即使 Start 松开，Q 会通过自身触点持续保持。",
      created_at: mins(5),
    },
    {
      id: "t6",
      kind: "mentor",
      text: "先在纸上手绘一次自保持梯形图，标出 Start、Stop、Q 三个信号在 3 个扫描周期内的状态，再回到仿真里跑一遍。",
      created_at: mins(3),
    },
  ],
  s_2001: [
    {
      id: "t1",
      kind: "prompt",
      text: "PID 输出一直饱和在 100%，Kp 已经降到 0.3 了还是不行。",
      created_at: mins(9),
    },
    {
      id: "t2",
      kind: "reply",
      text: "先检查采样是否稳定：如果反馈存在阶跃噪声，积分项会持续累积。可以先关闭 Ki 只用 P 观察响应。",
      created_at: mins(8),
    },
    {
      id: "t3",
      kind: "diagnosis",
      text: "积分饱和 (Integral Windup) 高置信度。学员未启用抗饱和逻辑，且 Ti 过小。建议现场停机并检查限幅是否作用于内环。",
      created_at: mins(7),
      severity: "error",
      tag: "积分饱和",
    },
    {
      id: "t4",
      kind: "mentor",
      text: "先把 PID 切到手动、观察 PV 曲线 30 秒；再启用限幅 + Anti-windup，Ti 从 60s 起调。",
      created_at: mins(2),
    },
  ],
  s_3001: [
    {
      id: "t1",
      kind: "prompt",
      text: "REAL 和 LREAL 在实际项目里怎么选？",
      created_at: mins(30),
    },
    {
      id: "t2",
      kind: "reply",
      text: "常规工艺量（温度、压力、流量）REAL 精度足够；能耗/计量、长时间积分建议 LREAL 避免累计误差。",
      created_at: mins(29),
    },
    {
      id: "t3",
      kind: "diagnosis",
      text: "掌握良好：能主动追问精度权衡，可推进到浮点异常与 NaN 传播章节。",
      created_at: mins(28),
      severity: "ok",
      tag: "进阶就绪",
    },
  ],
};

export function timelineFor(sessionId: string | null): TimelineItem[] {
  if (!sessionId) return [];
  return mockTimeline[sessionId] ?? [];
}

export function sessionsFor(studentId: string | null): Session[] {
  if (!studentId) return [];
  return mockSessions[studentId] ?? [];
}

export function formatTime(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  return d.toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(ts: number): string {
  const diff = Math.max(1, Math.floor(Date.now() / 1000 - ts));
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