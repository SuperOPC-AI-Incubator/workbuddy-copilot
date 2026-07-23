import { createClient } from "@supabase/supabase-js";
import type { ToolContext } from "@lovable.dev/mcp-js";

export function supabaseForUser(ctx: ToolContext) {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function unauth() {
  return {
    content: [{ type: "text" as const, text: "未登录 / Not authenticated" }],
    isError: true,
  };
}

export async function getMyStudent(ctx: ToolContext) {
  const sb = supabaseForUser(ctx);
  const { data, error } = await sb
    .from("students")
    .select("id, display_name")
    .eq("user_id", ctx.getUserId())
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { supabase: sb, student: data };
}
