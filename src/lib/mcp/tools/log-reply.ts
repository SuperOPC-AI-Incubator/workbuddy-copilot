import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser, unauth } from "./_supabase";

export default defineTool({
  name: "log_reply",
  title: "记录 AI 回复 / Log an AI reply",
  description: "将 WorkBuddy 中 AI 给学员的回复同步到 timeline。",
  inputSchema: {
    session_id: z.string().uuid(),
    text: z.string().min(1).max(8000).describe("AI 回复的原文"),
    tag: z.string().max(60).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async ({ session_id, text, tag }, ctx) => {
    if (!ctx.isAuthenticated()) return unauth();
    const sb = supabaseForUser(ctx);
    const { data, error } = await sb
      .from("timeline_items")
      .insert({ session_id, kind: "reply", text, tag: tag ?? null, author_id: ctx.getUserId() })
      .select("id")
      .single();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: `已记录 AI 回复 (id=${data.id})` }],
      structuredContent: { item_id: data.id },
    };
  },
});