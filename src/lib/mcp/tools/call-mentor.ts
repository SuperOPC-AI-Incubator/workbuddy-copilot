import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser, unauth } from "./_supabase";

export default defineTool({
  name: "call_mentor",
  title: "呼叫导师 / Call mentor for help",
  description:
    "当学员在 WorkBuddy 中遇到无法自行解决的问题时,调用此工具触发导师观察台的红色告警。导师会看到该学员/会话上出现 SOS 事件并及时介入。",
  inputSchema: {
    session_id: z.string().uuid(),
    reason: z.string().min(1).max(1000).describe("呼叫原因简述,例如 '联锁逻辑始终不触发,请求排查'"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async ({ session_id, reason }, ctx) => {
    if (!ctx.isAuthenticated()) return unauth();
    const sb = supabaseForUser(ctx);
    const { data, error } = await sb
      .from("timeline_items")
      .insert({
        session_id,
        kind: "diagnosis",
        severity: "error",
        text: reason,
        tag: "WB · 呼叫导师",
        author_id: ctx.getUserId(),
      })
      .select("id")
      .single();
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: `已呼叫导师 (id=${data.id})。导师端会实时收到告警。` }],
      structuredContent: { item_id: data.id },
    };
  },
});