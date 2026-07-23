import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { getMyStudent, supabaseForUser, unauth } from "./_supabase";

export default defineTool({
  name: "log_turn",
  title: "记录一轮对话 / Log a full turn",
  description:
    "**每一轮学员对话都必须调用此工具**,一次性把学员提问 + AI 回复(+ 可选诊断)写入云端 timeline。若未提供 session_id 会自动复用最近 6 小时的会话或新建。这是同步聊天记录到导师观察台的核心工具。",
  inputSchema: {
    session_id: z
      .string()
      .uuid()
      .optional()
      .describe("目标会话 id;缺省时自动 ensure_active_session"),
    prompt: z.string().min(1).max(4000).describe("学员本轮的原始提问"),
    reply: z.string().min(1).max(8000).describe("AI 本轮给学员的完整回复"),
    diagnosis: z
      .object({
        text: z.string().min(1).max(2000),
        severity: z.enum(["ok", "warn", "error"]),
      })
      .optional()
      .describe("可选:AI 对学员当前状态的诊断。severity=error 会触发导师端红色告警"),
    tag: z.string().max(60).optional().describe("可选标签,例如 'PLC/联锁'"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async ({ session_id, prompt, reply, diagnosis, tag }, ctx) => {
    if (!ctx.isAuthenticated()) return unauth();
    const { supabase, student } = await getMyStudent(ctx);
    if (!student) return { content: [{ type: "text", text: "未找到学员档案" }], isError: true };
    const sb = supabaseForUser(ctx);

    let sid = session_id;
    if (!sid) {
      const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
      const { data: recent } = await supabase
        .from("sessions")
        .select("id")
        .eq("student_id", student.id)
        .gte("updated_at", sixHoursAgo)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (recent) sid = recent.id;
      else {
        const { data: created, error: cErr } = await supabase
          .from("sessions")
          .insert({
            student_id: student.id,
            session_title: `WorkBuddy 对话 ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
            session_group: "task",
          })
          .select("id")
          .single();
        if (cErr) return { content: [{ type: "text", text: cErr.message }], isError: true };
        sid = created.id;
      }
    }

    const tagValue = tag ? `WB · ${tag}` : "WorkBuddy";
    const authorId = ctx.getUserId()!;
    const rows: Array<{
      session_id: string;
      kind: "prompt" | "reply" | "diagnosis";
      text: string;
      tag: string;
      author_id: string;
      severity?: "ok" | "warn" | "error";
    }> = [
      { session_id: sid!, kind: "prompt", text: prompt, tag: tagValue, author_id: authorId },
      { session_id: sid!, kind: "reply", text: reply, tag: tagValue, author_id: authorId },
    ];
    if (diagnosis) {
      rows.push({
        session_id: sid!,
        kind: "diagnosis",
        text: diagnosis.text,
        tag: tagValue,
        author_id: authorId,
        severity: diagnosis.severity,
      });
    }
    const { error } = await sb.from("timeline_items").insert(rows);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: `已同步本轮对话到 session=${sid} (${rows.length} 条)` }],
      structuredContent: { session_id: sid, inserted: rows.length },
    };
  },
});
