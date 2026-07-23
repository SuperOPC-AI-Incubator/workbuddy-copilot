import { describe, expect, test } from "vitest";

import { getAIUserMessage } from "@/lib/ai-user-messages";

describe("AI user messages", () => {
  test("maps known draft failures and unknown values to one safe fallback", () => {
    expect(getAIUserMessage("AI_UNAVAILABLE", "draft")).toBe(
      "AI草稿暂不可用，人工导师功能不受影响",
    );
    expect(getAIUserMessage("AI_DRAFT_FAILED", "draft")).toBe(
      "AI草稿暂不可用，人工导师功能不受影响",
    );
    expect(getAIUserMessage("PRIVATE_PROVIDER_BODY", "draft")).toBe(
      "AI草稿暂不可用，人工导师功能不受影响",
    );
  });

  test("maps student persistence failures without echoing unknown details", () => {
    expect(getAIUserMessage("AI_RESPONSE_PERSIST_FAILED", "student")).toBe(
      "AI 回复保存失败，请稍后重试；你的输入已保留。",
    );
    expect(getAIUserMessage("PRIVATE_DATABASE_DETAIL", "student")).toBe(
      "AI 请求暂不可用，请稍后重试；你的输入已保留。",
    );
  });
});
