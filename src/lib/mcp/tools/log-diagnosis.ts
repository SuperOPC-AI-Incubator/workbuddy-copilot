import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser, unauth } from "./_supabase";

export default defineTool({
  name: "log_diagnosis",
  title: "记录问题诊断 / Log a diagnosis",
  description:
    "记录 AI 对学员当前问题的诊断结论,严重度为 ok/warn/error。导师端会根据 severity 高亮红点。",
  inputSchema: {
    session_id: z.string().uuid(),
    text: z.string().min(1).max(4000),
    severity: z.enum(["ok", "warn", "error"]).describe("严重度: ok=已理解/正常, warn=需要关注, error=需要导师介入"),
    tag: z.string().max(60).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async ({ session_id, text, severity, tag }, ctx) => {
    if (!ctx.isAuthenticated()) return unauth();
    const sb = supabaseForUser(ctx);
    const { data, error } = await sb
      .from("timeline_items")
      .insert({
        session_id,
        kind: "diagnosis",
        text,
        severity,
        tag: tag ? `WB · ${tag}` : "WorkBuddy",
        author_id: ctx.getUserId(),
      })
      .select("id")
      .single();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: `已记录诊断 (id=${data.id}, severity=${severity})` }],
      structuredContent: { item_id: data.id },
    };
  },
});