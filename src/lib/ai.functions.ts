import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Keep this file as thin server-function wrappers; implementation lives in ai.server.ts
// and is loaded inside handlers so client-side planning never imports server-only modules.
export const askAI = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ sessionId: z.string().uuid(), prompt: z.string().min(1).max(2000) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");

    const { supabase, userId } = context;

    // 1. Insert student prompt (RLS enforces session ownership)
    const { error: insErr } = await supabase.from("timeline_items").insert({
      session_id: data.sessionId,
      kind: "prompt",
      text: data.prompt,
      author_id: userId,
    });
    if (insErr) throw insErr;

    let reply = "";
    let diagnosis = "";
    let severity: "ok" | "warn" | "error" = "ok";
    let tag = "";
    try {
      const { answerStudentPrompt } = await import("./ai.server");
      const answer = await answerStudentPrompt(supabase, data.sessionId, data.prompt, apiKey);
      reply = answer.reply;
      diagnosis = answer.diagnosis;
      severity = answer.severity;
      tag = answer.tag;
    } catch (e) {
      reply = `AI 暂时无法回答：${(e as Error).message}`;
      diagnosis = "";
      severity = "warn";
    }

    // 3. Insert reply
    await supabase.from("timeline_items").insert({
      session_id: data.sessionId,
      kind: "reply",
      text: reply,
      author_id: userId,
      tag: tag || null,
    });
    // 4. Insert diagnosis if any
    if (diagnosis) {
      await supabase.from("timeline_items").insert({
        session_id: data.sessionId,
        kind: "diagnosis",
        text: diagnosis,
        severity,
        author_id: userId,
      });
    }

    return { ok: true };
  });

export const draftMentorTip = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) =>
    z.object({ sessionId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY");

    const { createMentorDraft } = await import("./ai.server");
    const draft = await createMentorDraft(context.supabase, data.sessionId, apiKey);
    return { draft };
  });