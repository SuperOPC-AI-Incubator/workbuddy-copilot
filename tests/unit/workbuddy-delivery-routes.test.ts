import { describe, expect, test, vi } from "vitest";

import {
  DeliveryGatewayError,
  DeliveryOwnershipError,
  type WorkbuddyMentorMessagePage,
} from "@/lib/workbuddy/delivery.server";
import {
  createMentorMessagesGetHandler,
  mentorMessagesOptions,
} from "@/routes/api/public/workbuddy/mentor-messages";
import {
  MAX_WORKBUDDY_ACK_BODY_BYTES,
  createMentorMessagesAckPostHandler,
} from "@/routes/api/public/workbuddy/mentor-messages/ack";
import {
  InvalidWorkbuddyCredentialError,
  RevokedWorkbuddyCredentialError,
} from "@/lib/workbuddy/contracts";

const STUDENT_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "40000000-0000-4000-8000-000000000001";
const REQUEST_ID = "60000000-0000-4000-8000-000000000001";

const page: WorkbuddyMentorMessagePage = {
  messages: [
    {
      id: MESSAGE_ID,
      session_id: SESSION_ID,
      text: "导师建议",
      author_username: "mentor-one",
      created_at: "2026-07-23T09:30:00.000Z",
      first_fetched_at: "2026-07-23T09:31:00.000Z",
      last_fetched_at: "2026-07-23T09:31:00.000Z",
      fetch_count: 1,
    },
  ],
  next_cursor: null,
};

describe("public mentor message routes", () => {
  function getHandler(overrides: Record<string, unknown> = {}) {
    return createMentorMessagesGetHandler({
      resolveCredential: async () => ({ studentId: STUDENT_ID }),
      fetchMessages: async () => page,
      requestId: () => REQUEST_ID,
      ...overrides,
    });
  }

  function ackHandler(overrides: Record<string, unknown> = {}) {
    return createMentorMessagesAckPostHandler({
      resolveCredential: async () => ({ studentId: STUDENT_ID }),
      acknowledgeMessages: async () => ({
        acknowledged: [{ id: MESSAGE_ID, acknowledged_at: "2026-07-23T09:32:00.000Z" }],
      }),
      requestId: () => REQUEST_ID,
      ...overrides,
    });
  }

  test("GET authenticates the token owner, parses query fields, and returns CORS/request ID", async () => {
    const resolveCredential = vi.fn(async () => ({ studentId: STUDENT_ID }));
    const fetchMessages = vi.fn(async () => page);
    const response = await getHandler({ resolveCredential, fetchMessages })(
      new Request(
        `http://localhost/api/public/workbuddy/mentor-messages?session_id=${SESSION_ID}&limit=25`,
        { headers: { authorization: "Bearer presented_once" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(resolveCredential).toHaveBeenCalledWith("presented_once");
    expect(fetchMessages).toHaveBeenCalledWith({
      studentId: STUDENT_ID,
      sessionId: SESSION_ID,
      limit: 25,
      cursor: undefined,
    });
    expect(await response.json()).toEqual({ ok: true, request_id: REQUEST_ID, ...page });
  });

  test("POST ack authenticates first and forwards only the token-owned student", async () => {
    const acknowledgeMessages = vi.fn(async () => ({
      acknowledged: [{ id: MESSAGE_ID, acknowledged_at: "2026-07-23T09:32:00.000Z" }],
    }));
    const response = await ackHandler({ acknowledgeMessages })(
      new Request("http://localhost/api/public/workbuddy/mentor-messages/ack", {
        method: "POST",
        headers: {
          authorization: "Bearer presented_once",
          "content-type": "application/json",
        },
        body: JSON.stringify({ message_ids: [MESSAGE_ID] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(acknowledgeMessages).toHaveBeenCalledWith({
      studentId: STUDENT_ID,
      messageIds: [MESSAGE_ID],
    });
    expect(await response.json()).toEqual({
      ok: true,
      request_id: REQUEST_ID,
      acknowledged: [{ id: MESSAGE_ID, acknowledged_at: "2026-07-23T09:32:00.000Z" }],
    });
  });

  test.each([InvalidWorkbuddyCredentialError, RevokedWorkbuddyCredentialError])(
    "uses one sanitized 401 for invalid and revoked credentials",
    async (ErrorType) => {
      const response = await getHandler({
        resolveCredential: async () => {
          throw new ErrorType();
        },
      })(
        new Request("http://localhost/api/public/workbuddy/mentor-messages", {
          headers: { authorization: "Bearer rejected" },
        }),
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid WorkBuddy credential",
          request_id: REQUEST_ID,
        },
      });
    },
  );

  test("POST ack authenticates before parsing an untrusted body", async () => {
    const response = await ackHandler()(
      new Request("http://localhost/api/public/workbuddy/mentor-messages/ack", {
        method: "POST",
        body: "{",
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid WorkBuddy credential",
        request_id: REQUEST_ID,
      },
    });
  });

  test("rejects unknown/malformed query fields before fetch", async () => {
    const fetchMessages = vi.fn(async () => page);
    for (const query of [
      "?limit=0",
      "?limit=101",
      "?limit=1.5",
      "?session_id=not-a-uuid",
      "?cursor=not-a-cursor",
      "?student_id=forged",
      "?limit=10&limit=11",
    ]) {
      const response = await getHandler({ fetchMessages })(
        new Request(`http://localhost/api/public/workbuddy/mentor-messages${query}`, {
          headers: { authorization: "Bearer valid" },
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(fetchMessages).not.toHaveBeenCalled();
  });

  test("rejects malformed, duplicate, invalid-UTF8, and oversized ack bodies", async () => {
    const acknowledgeMessages = vi.fn();
    const requests = [
      new Request("http://localhost/api/public/workbuddy/mentor-messages/ack", {
        method: "POST",
        headers: { authorization: "Bearer valid" },
        body: "{",
      }),
      new Request("http://localhost/api/public/workbuddy/mentor-messages/ack", {
        method: "POST",
        headers: { authorization: "Bearer valid" },
        body: JSON.stringify({ message_ids: [MESSAGE_ID, MESSAGE_ID] }),
      }),
      new Request("http://localhost/api/public/workbuddy/mentor-messages/ack", {
        method: "POST",
        headers: { authorization: "Bearer valid" },
        body: new Uint8Array([0xc3, 0x28]),
      }),
      new Request("http://localhost/api/public/workbuddy/mentor-messages/ack", {
        method: "POST",
        headers: {
          authorization: "Bearer valid",
          "content-length": String(MAX_WORKBUDDY_ACK_BODY_BYTES + 1),
        },
        body: "{}",
      }),
    ];

    for (const request of requests) {
      const response = await ackHandler({ acknowledgeMessages })(request);
      expect([400, 413]).toContain(response.status);
    }
    expect(acknowledgeMessages).not.toHaveBeenCalled();
  });

  test("mixed ownership is a stable non-disclosing 400 and gateway drift is a sanitized 500", async () => {
    const mixed = await ackHandler({
      acknowledgeMessages: async () => {
        throw new DeliveryOwnershipError();
      },
    })(
      new Request("http://localhost/api/public/workbuddy/mentor-messages/ack", {
        method: "POST",
        headers: { authorization: "Bearer valid" },
        body: JSON.stringify({ message_ids: [MESSAGE_ID] }),
      }),
    );
    expect(mixed.status).toBe(400);
    expect(await mixed.json()).toEqual({
      error: {
        code: "INVALID_MESSAGE_IDS",
        message: "Message IDs are invalid",
        request_id: REQUEST_ID,
      },
    });

    const failure = await getHandler({
      fetchMessages: async () => {
        throw new DeliveryGatewayError();
      },
    })(
      new Request("http://localhost/api/public/workbuddy/mentor-messages", {
        headers: { authorization: "Bearer valid" },
      }),
    );
    expect(failure.status).toBe(500);
    expect(JSON.stringify(await failure.json())).toBe(
      JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
          request_id: REQUEST_ID,
        },
      }),
    );
  });

  test("OPTIONS advertises GET and POST without touching dependencies", async () => {
    const response = mentorMessagesOptions();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });
});
