import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser, unauth } from "./_supabase";

export default defineTool({
  name: "log_prompt",
  title: "记录学员提问 / Log a student prompt",
  description:
    "将学员在 WorkBuddy 中向 AI 发出的提问同步到导师观察台的 timeline。使用前先通过 get_my_sessions 或 create_session 取得 session_id。",
  inputSchema: {
    session_id: z.string().uuid().describe("目标会话 id"),
    text: z.string().min(1).max(4000).describe("学员的提问原文"),
    tag: z.string().max(60).optional().describe("可选标签,例如 'PLC/联锁'"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  handler: async ({ session_id, text, tag }, ctx) => {
    if (!ctx.isAuthenticated()) return unauth();
    const sb = supabaseForUser(ctx);
    const { data, error } = await sb
      .from("timeline_items")
      .insert({
        session_id,
        kind: "prompt",
        text,
        tag: tag ? `WB · ${tag}` : "WorkBuddy",
        author_id: ctx.getUserId(),
      })
      .select("id")
      .single();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: `已记录提问 (id=${data.id})` }],
      structuredContent: { item_id: data.id },
    };
  },
});