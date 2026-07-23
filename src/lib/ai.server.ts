import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const MODEL = "deepseek-chat";

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };
type SB = SupabaseClient<Database>;

type HistoryRow = {
  kind: "prompt" | "reply" | "diagnosis" | "mentor";
  text: string;
  tag: string | null;
  severity: "ok" | "warn" | "error" | null;
  created_at: string;
};

type StudentAnswer = {
  reply: string;
  diagnosis: string;
  severity: "ok" | "warn" | "error";
  tag: string;
};

const STUDENT_SYSTEM = `你是 WorkBuddy Copilot，一位专业的 PLC (可编程逻辑控制器) 工业自动化学习助教。
学员正在学习 PLC 编程与实操，请：
1. 用简洁准确的中文回答（150 字以内）。
2. 涉及梯形图/指令时，用代码块或分点说明。
3. 强调安全与工程规范（联锁、急停、上电顺序等）。
严格输出 JSON，字段：
{"reply": "给学员的答复", "diagnosis": "对学员掌握程度的简短诊断（30 字内）", "severity": "ok" | "warn" | "error", "tag": "可选的知识点标签，5 字内或空字符串"}
severity 规则：概念清晰=ok；有小误解=warn；涉及安全隐患或严重错误=error。`;

const MENTOR_SYSTEM = `你是资深 PLC 工程师，正在协助导师给学员发送一条"导师提示"。
基于下方对话时间线，草拟一条 60 字以内、可直接发送的中文提示，聚焦最需要点拨的地方（可指出隐患、追问思路或推荐下一步实操）。
只输出提示正文，不要引号、不要前缀。`;

async function callDeepseek(
  apiKey: string,
  messages: ChatMsg[],
  opts?: { json?: boolean; temperature?: number },
) {
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: opts?.temperature ?? 0.5,
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Deepseek ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

async function loadRecentTimeline(
  supabase: SB,
  sessionId: string,
  limit = 20,
): Promise<HistoryRow[]> {
  const { data, error } = await supabase
    .from("timeline_items")
    .select("kind, text, tag, severity, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return ((data ?? []) as HistoryRow[]).reverse();
}

export async function answerStudentPrompt(
  supabase: SB,
  sessionId: string,
  prompt: string,
  apiKey: string,
): Promise<StudentAnswer> {
  const history = await loadRecentTimeline(supabase, sessionId, 12);
  const messages: ChatMsg[] = [
    { role: "system", content: STUDENT_SYSTEM },
    ...history.slice(0, -1).map<ChatMsg>((item) => ({
      role: item.kind === "prompt" ? "user" : "assistant",
      content: item.text,
    })),
    { role: "user", content: prompt },
  ];

  const raw = await callDeepseek(apiKey, messages, { json: true, temperature: 0.4 });
  type Parsed = { reply?: string; diagnosis?: string; severity?: string; tag?: string };
  let parsed: Parsed = {};
  const tryParse = (s: string): Parsed | null => {
    try {
      return JSON.parse(s) as Parsed;
    } catch {
      return null;
    }
  };
  if (raw) {
    parsed = tryParse(raw) ?? {};
    if (!parsed.reply) {
      // Attempt to extract JSON object substring
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) parsed = tryParse(match[0]) ?? parsed;
    }
  }
  if (!parsed.reply) {
    // Fallback: treat entire raw text as reply
    return {
      reply: raw?.trim() || "AI 暂无回复，请稍后重试。",
      diagnosis: "",
      severity: "ok",
      tag: "",
    };
  }

  return {
    reply: parsed.reply.trim(),
    diagnosis: parsed.diagnosis?.trim() ?? "",
    severity: parsed.severity === "warn" || parsed.severity === "error" ? parsed.severity : "ok",
    tag: parsed.tag?.trim() ?? "",
  };
}

export async function createMentorDraft(
  supabase: SB,
  sessionId: string,
  apiKey: string,
): Promise<string> {
  const history = await loadRecentTimeline(supabase, sessionId, 16);
  if (history.length === 0) return "";

  const transcript = history
    .map((item) => {
      const role =
        item.kind === "prompt"
          ? "学员"
          : item.kind === "reply"
            ? "AI"
            : item.kind === "diagnosis"
              ? "诊断"
              : "导师";
      return `[${role}] ${item.text}`;
    })
    .join("\n");

  return callDeepseek(
    apiKey,
    [
      { role: "system", content: MENTOR_SYSTEM },
      { role: "user", content: transcript },
    ],
    { temperature: 0.6 },
  );
}
