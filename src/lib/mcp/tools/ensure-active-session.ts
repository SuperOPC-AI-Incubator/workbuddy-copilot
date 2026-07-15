import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { getMyStudent, unauth } from "./_supabase";

export default defineTool({
  name: "ensure_active_session",
  title: "获取或创建当前会话 / Ensure active session",
  description:
    "返回当前学员最近 6 小时内最新的会话 id;若没有则自动创建一个。用法:每轮对话开始前调用一次拿到 session_id,再调用 log_turn。零参数即可。",
  inputSchema: {
    title: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("若需要新建时使用的会话标题,缺省用 '未命名任务 <时间>'"),
  },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ title }, ctx) => {
    if (!ctx.isAuthenticated()) return unauth();
    const { supabase, student } = await getMyStudent(ctx);
    if (!student) return { content: [{ type: "text", text: "未找到学员档案(仅学员角色可用)" }], isError: true };

    const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const { data: recent } = await supabase
      .from("sessions")
      .select("id, session_title, updated_at")
      .eq("student_id", student.id)
      .gte("updated_at", sixHoursAgo)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recent) {
      return {
        content: [{ type: "text", text: `复用会话 "${recent.session_title}" (id=${recent.id})` }],
        structuredContent: { session_id: recent.id, reused: true },
      };
    }

    const fallback = title ?? `未命名任务 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    const { data, error } = await supabase
      .from("sessions")
      .insert({ student_id: student.id, session_title: fallback, session_group: "task" })
      .select("id, session_title")
      .single();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: `已新建会话 "${data.session_title}" (id=${data.id})` }],
      structuredContent: { session_id: data.id, reused: false },
    };
  },
});
