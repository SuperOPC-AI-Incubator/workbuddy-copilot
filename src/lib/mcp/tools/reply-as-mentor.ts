import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser, unauth } from "./_supabase";

export default defineTool({
  name: "reply_as_mentor",
  title: "导师回复学员 / Reply as mentor",
  description: "导师专用: 向指定学员会话的 timeline 中插入一条 mentor 消息。RLS 要求调用者具备 mentor 角色。",
  inputSchema: {
    session_id: z.string().uuid(),
    text: z.string().min(1).max(8000),
    tag: z.string().max(60).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async ({ session_id, text, tag }, ctx) => {
    if (!ctx.isAuthenticated()) return unauth();
    const sb = supabaseForUser(ctx);
    const { data, error } = await sb
      .from("timeline_items")
      .insert({
        session_id,
        kind: "mentor",
        text,
        tag: tag ? `WB · ${tag}` : "WorkBuddy · 导师",
        author_id: ctx.getUserId(),
      })
      .select("id")
      .single();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: `已发送导师回复 (id=${data.id})` }],
      structuredContent: { item_id: data.id },
    };
  },
});