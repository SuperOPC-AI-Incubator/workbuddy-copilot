import { describe, expect, test } from "vitest";

import {
  AIResponsePersistError,
  persistAIResponse,
  type AIResponseGateway,
} from "@/lib/ai-response.server";

const ACTOR_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const REPLY_ID = "40000000-0000-4000-8000-000000000001";
const DIAGNOSIS_ID = "40000000-0000-4000-8000-000000000002";

class RecordingGateway implements AIResponseGateway {
  calls: Array<Parameters<AIResponseGateway["create"]>[0]> = [];
  response: Awaited<ReturnType<AIResponseGateway["create"]>> = {
    data: {
      session_id: SESSION_ID,
      reply_item_id: REPLY_ID,
      diagnosis_item_id: DIAGNOSIS_ID,
    },
    error: null,
  };

  async create(args: Parameters<AIResponseGateway["create"]>[0]) {
    this.calls.push(args);
    return this.response;
  }
}

describe("AI response persistence", () => {
  test("uses only the verified actor and one atomic RPC result", async () => {
    const gateway = new RecordingGateway();
    const result = await persistAIResponse(
      {
        actorUserId: ACTOR_ID,
        input: {
          sessionId: SESSION_ID,
          reply: "下一步先写出目标。",
          diagnosis: "目标仍不够具体",
          severity: "warn",
          tag: "目标",
        },
      },
      { gateway },
    );

    expect(gateway.calls).toEqual([
      {
        _actor_user_id: ACTOR_ID,
        _session_id: SESSION_ID,
        _reply: "下一步先写出目标。",
        _diagnosis_text: "目标仍不够具体",
        _diagnosis_severity: "warn",
        _tag: "目标",
      },
    ]);
    expect(result).toEqual({
      sessionId: SESSION_ID,
      replyItemId: REPLY_ID,
      diagnosisItemId: DIAGNOSIS_ID,
    });
  });

  test.each(["forced_reply_failure", "forced_diagnosis_failure"])(
    "fails closed and sanitizes %s",
    async (internalMessage) => {
      const gateway = new RecordingGateway();
      gateway.response = {
        data: null,
        error: { code: "P0001", message: `${internalMessage}: PRIVATE_DATABASE_DETAIL` },
      };

      const failure = persistAIResponse(
        {
          actorUserId: ACTOR_ID,
          input: {
            sessionId: SESSION_ID,
            reply: "回复",
            diagnosis: "诊断",
            severity: "warn",
            tag: "",
          },
        },
        { gateway },
      );
      await expect(failure).rejects.toBeInstanceOf(AIResponsePersistError);
      await expect(failure).rejects.toMatchObject({
        code: "AI_RESPONSE_PERSIST_FAILED",
        message: "AI 回复保存失败，请稍后重试。",
      });
      await expect(failure).rejects.not.toThrow("PRIVATE_DATABASE_DETAIL");
    },
  );

  test("rejects a malformed partial RPC result", async () => {
    const gateway = new RecordingGateway();
    gateway.response = {
      data: {
        session_id: SESSION_ID,
        reply_item_id: REPLY_ID,
        diagnosis_item_id: null,
        internal_student_id: ACTOR_ID,
      },
      error: null,
    };

    await expect(
      persistAIResponse(
        {
          actorUserId: ACTOR_ID,
          input: {
            sessionId: SESSION_ID,
            reply: "回复",
            diagnosis: "诊断",
            severity: "warn",
            tag: null,
          },
        },
        { gateway },
      ),
    ).rejects.toMatchObject({ code: "AI_RESPONSE_RESULT_INVALID" });
  });
});
