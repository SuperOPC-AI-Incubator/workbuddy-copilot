import { describe, expect, test } from "vitest";

import {
  MentorMessageCreateError,
  createMentorMessage,
  type MentorMessageGateway,
} from "@/lib/mentor-messages.server";

const ACTOR_ID = "10000000-0000-4000-8000-000000000101";
const STUDENT_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "40000000-0000-4000-8000-000000000001";

class RecordingGateway implements MentorMessageGateway {
  calls: Array<Parameters<MentorMessageGateway["create"]>[0]> = [];
  response: Awaited<ReturnType<MentorMessageGateway["create"]>> = {
    data: {
      message_id: MESSAGE_ID,
      student_id: STUDENT_ID,
      session_id: SESSION_ID,
      delivery_state: "pending",
    },
    error: null,
  };

  async create(args: Parameters<MentorMessageGateway["create"]>[0]) {
    this.calls.push(args);
    return this.response;
  }
}

describe("mentor message creation service", () => {
  test("derives the trusted author and accepts no client student or author fields", async () => {
    const gateway = new RecordingGateway();
    const result = await createMentorMessage(
      {
        actorUserId: ACTOR_ID,
        input: { sessionId: SESSION_ID, text: "  请先复述你的判断依据。  ", severity: "warn" },
      },
      { gateway },
    );

    expect(gateway.calls).toEqual([
      {
        _author_user_id: ACTOR_ID,
        _session_id: SESSION_ID,
        _text: "请先复述你的判断依据。",
        _severity: "warn",
      },
    ]);
    expect(result).toEqual({
      messageId: MESSAGE_ID,
      sessionId: SESSION_ID,
      deliveryState: "pending",
    });
    expect(JSON.stringify(result)).not.toContain(STUDENT_ID);
  });

  test("rejects spoofing fields and oversized content before the gateway", async () => {
    const gateway = new RecordingGateway();
    await expect(
      createMentorMessage(
        {
          actorUserId: ACTOR_ID,
          input: {
            sessionId: SESSION_ID,
            text: "hello",
            authorUsername: "spoofed",
          } as never,
        },
        { gateway },
      ),
    ).rejects.toBeInstanceOf(MentorMessageCreateError);
    await expect(
      createMentorMessage(
        {
          actorUserId: ACTOR_ID,
          input: { sessionId: SESSION_ID, text: "学".repeat(8_001) },
        },
        { gateway },
      ),
    ).rejects.toBeInstanceOf(MentorMessageCreateError);
    expect(gateway.calls).toHaveLength(0);
  });

  test.each([
    ["disabled staff", "42501", "active_staff_account_required"],
    ["password change incomplete", "42501", "active_staff_account_required"],
    ["student actor", "42501", "active_staff_role_required"],
    ["partial trigger failure", "P0001", "delivery_trigger_failed"],
  ])("fails closed for %s without leaking gateway details", async (_case, code, message) => {
    const gateway = new RecordingGateway();
    gateway.response = { data: null, error: { code, message } };

    const failure = createMentorMessage(
      { actorUserId: ACTOR_ID, input: { sessionId: SESSION_ID, text: "消息" } },
      { gateway },
    );
    await expect(failure).rejects.toMatchObject({
      code: "MENTOR_MESSAGE_CREATE_FAILED",
      message: "导师消息发送失败，请稍后重试。",
    });
    await expect(failure).rejects.not.toThrow(message);
  });

  test("rejects malformed or non-pending RPC results as a server failure", async () => {
    const gateway = new RecordingGateway();
    gateway.response = {
      data: { message_id: MESSAGE_ID, session_id: SESSION_ID, delivery_state: "acknowledged" },
      error: null,
    };

    await expect(
      createMentorMessage(
        { actorUserId: ACTOR_ID, input: { sessionId: SESSION_ID, text: "消息" } },
        { gateway },
      ),
    ).rejects.toMatchObject({ code: "MENTOR_MESSAGE_RESULT_INVALID" });
  });
});
