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
    const { supabase, userId } = context;
    const {
      aiUnavailableResult,
      answerStudentPromptFromEnvironment,
      isAIAvailableFromEnvironment,
    } = await import("./ai.server");
    if (!isAIAvailableFromEnvironment()) return aiUnavailableResult("student");

    // 1. Insert student prompt (RLS enforces session ownership)
    const { error: insErr } = await supabase.from("timeline_items").insert({
      session_id: data.sessionId,
      kind: "prompt",
      text: data.prompt,
      author_id: userId,
    });
    if (insErr) {
      console.warn("[AI]", { code: "AI_PROMPT_PERSIST_FAILED" });
      return {
        available: true as const,
        ok: false as const,
        code: "AI_PROMPT_PERSIST_FAILED" as const,
        message: "学员提问保存失败，请稍后重试。",
      };
    }

    let reply = "";
    let diagnosis = "";
    let severity: "ok" | "warn" | "error" = "ok";
    let tag = "";
    try {
      const aiResult = await answerStudentPromptFromEnvironment(
        supabase,
        data.sessionId,
        data.prompt,
      );
      if (aiResult.available) {
        reply = aiResult.answer.reply;
        diagnosis = aiResult.answer.diagnosis;
        severity = aiResult.answer.severity;
        tag = aiResult.answer.tag;
      } else {
        reply = aiResult.message;
        severity = "warn";
      }
    } catch {
      console.warn("[AI]", { code: "STUDENT_ANSWER_FAILED" });
      reply = "AI 暂时无法回答，请稍后重试。";
      diagnosis = "";
      severity = "warn";
    }

    try {
      const { persistAIResponseOnServer } = await import("./ai-response.server");
      await persistAIResponseOnServer(userId, {
        sessionId: data.sessionId,
        reply,
        diagnosis: diagnosis || null,
        severity: diagnosis ? severity : null,
        tag: tag || null,
      });
    } catch {
      console.warn("[AI]", { code: "AI_RESPONSE_PERSIST_FAILED" });
      return {
        available: true as const,
        ok: false as const,
        code: "AI_RESPONSE_PERSIST_FAILED" as const,
        message: "AI 回复保存失败，请稍后重试。",
      };
    }

    return { available: true as const, ok: true as const, code: "OK" as const };
  });

export const draftMentorTip = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ sessionId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { createMentorDraftFromEnvironment } = await import("./ai.server");
    try {
      return await createMentorDraftFromEnvironment(context.supabase, data.sessionId);
    } catch {
      console.warn("[AI]", { code: "AI_DRAFT_FAILED" });
      return {
        available: false as const,
        code: "AI_DRAFT_FAILED" as const,
        message: "AI草稿暂不可用，人工导师功能不受影响",
        draft: "" as const,
      };
    }
  });
