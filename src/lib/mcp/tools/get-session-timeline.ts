import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser, unauth } from "./_supabase";

export default defineTool({
  name: "get_session_timeline",
  title: "查看会话时间线 / Get session timeline",
  description: "获取指定会话的完整 timeline(提问/回复/诊断/呼叫)。学员只能看自己的,导师可看全部。",
  inputSchema: {
    session_id: z.string().uuid(),
    limit: z.number().int().min(1).max(500).optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async ({ session_id, limit }, ctx) => {
    if (!ctx.isAuthenticated()) return unauth();
    const sb = supabaseForUser(ctx);
    const { data, error } = await sb
      .from("timeline_items")
      .select("id, kind, text, severity, tag, author_id, created_at")
      .eq("session_id", session_id)
      .order("created_at", { ascending: true })
      .limit(limit ?? 200);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { items: data },
    };
  },
});
