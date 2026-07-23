export type AIUserMessageMode = "student" | "draft";

const DRAFT_UNAVAILABLE = "AI草稿暂不可用，人工导师功能不受影响";

const STUDENT_MESSAGES: Record<string, string> = {
  AI_UNAVAILABLE: "AI 回答暂不可用，请稍后重试；你的输入已保留。",
  AI_PROMPT_PERSIST_FAILED: "学员提问保存失败，请稍后重试；你的输入已保留。",
  AI_RESPONSE_PERSIST_FAILED: "AI 回复保存失败，请稍后重试；你的输入已保留。",
};

export function getAIUserMessage(code: unknown, mode: AIUserMessageMode): string {
  if (mode === "draft") return DRAFT_UNAVAILABLE;
  if (typeof code === "string" && STUDENT_MESSAGES[code]) return STUDENT_MESSAGES[code];
  return "AI 请求暂不可用，请稍后重试；你的输入已保留。";
}
