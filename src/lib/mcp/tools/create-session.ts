import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { getMyStudent, unauth } from "./_supabase";

export default defineTool({
  name: "create_session",
  title: "创建新会话 / Create a new session",
  description:
    "为当前学员创建一个新的会话(session)。用于开始一段新的学习/编程任务。返回 session_id 供后续 log_* 工具使用。",
  inputSchema: {
    title: z.string().min(1).max(200).describe("会话标题,例如 '电机联锁调试'"),
    group: z
      .enum(["task", "space"])
      .optional()
      .describe("会话分组: task=任务对话, space=空间/长期主题; 默认 task"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  handler: async ({ title, group }, ctx) => {
    if (!ctx.isAuthenticated()) return unauth();
    const { supabase, student } = await getMyStudent(ctx);
    if (!student) return { content: [{ type: "text", text: "未找到学员档案(仅学员角色可用)" }], isError: true };
    const { data, error } = await supabase
      .from("sessions")
      .insert({ student_id: student.id, session_title: title, session_group: group ?? "task" })
      .select("id, session_title")
      .single();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: `已创建会话 "${data.session_title}" (id=${data.id})` }],
      structuredContent: { session_id: data.id, title: data.session_title },
    };
  },
});