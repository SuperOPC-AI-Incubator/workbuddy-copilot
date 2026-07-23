import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { getMyStudent, unauth } from "./_supabase";

export default defineTool({
  name: "get_my_sessions",
  title: "获取我的会话列表 / List my sessions",
  description: "列出当前学员最近的会话,便于选择要写入的 session_id。",
  inputSchema: {
    limit: z.number().int().min(1).max(50).optional().describe("最多返回条数,默认 10"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit }, ctx) => {
    if (!ctx.isAuthenticated()) return unauth();
    const { supabase, student } = await getMyStudent(ctx);
    if (!student) return { content: [{ type: "text", text: "未找到学员档案" }], isError: true };
    const { data, error } = await supabase
      .from("sessions")
      .select("id, session_title, session_group, last_severity, updated_at")
      .eq("student_id", student.id)
      .order("updated_at", { ascending: false })
      .limit(limit ?? 10);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { sessions: data },
    };
  },
});
