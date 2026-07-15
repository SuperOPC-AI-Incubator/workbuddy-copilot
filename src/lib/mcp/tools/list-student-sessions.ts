import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser, unauth } from "./_supabase";

export default defineTool({
  name: "list_student_sessions",
  title: "导师: 查看学员会话 / List a student's sessions (mentor)",
  description: "导师专用: 列出指定学员的所有会话。RLS 会拦截无权限访问。",
  inputSchema: {
    student_id: z.string().uuid(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async ({ student_id, limit }, ctx) => {
    if (!ctx.isAuthenticated()) return unauth();
    const sb = supabaseForUser(ctx);
    const { data, error } = await sb
      .from("sessions")
      .select("id, session_title, session_group, last_severity, updated_at, created_at")
      .eq("student_id", student_id)
      .order("updated_at", { ascending: false })
      .limit(limit ?? 50);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { sessions: data },
    };
  },
});