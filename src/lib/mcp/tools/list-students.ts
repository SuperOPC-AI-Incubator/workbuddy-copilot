import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser, unauth } from "./_supabase";

export default defineTool({
  name: "list_students",
  title: "导师: 查看所有学员 / List students (mentor)",
  description: "导师专用: 列出所有学员及其最近活动/严重度。仅具备 mentor 角色的账号可用。",
  inputSchema: {
    limit: z.number().int().min(1).max(200).optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async ({ limit }, ctx) => {
    if (!ctx.isAuthenticated()) return unauth();
    const sb = supabaseForUser(ctx);
    const { data, error } = await sb
      .from("students")
      .select("id, display_name, last_severity, last_active_at")
      .order("last_active_at", { ascending: false, nullsFirst: false })
      .limit(limit ?? 50);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: { students: data },
    };
  },
});