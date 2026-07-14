import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const MODEL = "deepseek-chat";

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

async function callDeepseek(messages: ChatMsg[], opts?: { json?: boolean; temperature?: number }) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("Missing DEEPSEEK_API_KEY");
  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: opts?.temperature ?? 0.5,
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Deepseek ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

async function loadRecentTimeline(
  supabase: Awaited<ReturnType<typeof requireSupabaseAuth.server>>["context"]["supabase"],
  sessionId: string,
  limit = 20,
) {
  const { data, error } = await supabase
    .from("timeline_items")
    .select("kind, text, tag, severity, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).reverse();
}

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

export const askAI = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ sessionId: z.string().uuid(), prompt: z.string().min(1).max(2000) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // 1. Insert student prompt (RLS enforces session ownership)
    const { error: insErr } = await supabase.from("timeline_items").insert({
      session_id: data.sessionId,
      kind: "prompt",
      text: data.prompt,
      author_id: userId,
    });
    if (insErr) throw insErr;

    // 2. Build context and call Deepseek
    const history = await loadRecentTimeline(supabase, data.sessionId, 12);
    const messages: ChatMsg[] = [
      { role: "system", content: STUDENT_SYSTEM },
      ...history.slice(0, -1).map<ChatMsg>((h) => ({
        role: h.kind === "prompt" ? "user" : "assistant",
        content: h.text,
      })),
      { role: "user", content: data.prompt },
    ];

    let reply = "";
    let diagnosis = "";
    let severity: "ok" | "warn" | "error" = "ok";
    let tag = "";
    try {
      const raw = await callDeepseek(messages, { json: true, temperature: 0.4 });
      const parsed = JSON.parse(raw) as {
        reply?: string;
        diagnosis?: string;
        severity?: string;
        tag?: string;
      };
      reply = parsed.reply?.trim() || raw;
      diagnosis = parsed.diagnosis?.trim() ?? "";
      if (parsed.severity === "warn" || parsed.severity === "error") severity = parsed.severity;
      tag = parsed.tag?.trim() ?? "";
    } catch (e) {
      reply = `AI 暂时无法回答：${(e as Error).message}`;
      diagnosis = "";
      severity = "warn";
    }

    // 3. Insert reply
    await supabase.from("timeline_items").insert({
      session_id: data.sessionId,
      kind: "reply",
      text: reply,
      author_id: userId,
      tag: tag || null,
    });
    // 4. Insert diagnosis if any
    if (diagnosis) {
      await supabase.from("timeline_items").insert({
        session_id: data.sessionId,
        kind: "diagnosis",
        text: diagnosis,
        severity,
        author_id: userId,
      });
    }

    return { ok: true };
  });

export const draftMentorTip = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ sessionId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const history = await loadRecentTimeline(context.supabase, data.sessionId, 16);
    if (history.length === 0) return { draft: "" };
    const transcript = history
      .map((h) => {
        const role =
          h.kind === "prompt" ? "学员" : h.kind === "reply" ? "AI" : h.kind === "diagnosis" ? "诊断" : "导师";
        return `[${role}] ${h.text}`;
      })
      .join("\n");
    const draft = await callDeepseek(
      [
        { role: "system", content: MENTOR_SYSTEM },
        { role: "user", content: transcript },
      ],
      { temperature: 0.6 },
    );
    return { draft };
  });