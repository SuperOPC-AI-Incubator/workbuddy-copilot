import { describe, expect, test, vi } from "vitest";

import {
  DeliveryGatewayError,
  DeliveryOwnershipError,
  InvalidDeliveryCursorError,
  acknowledgeMentorMessages,
  decodeDeliveryCursor,
  encodeDeliveryCursor,
  fetchPendingMentorMessages,
  type DeliveryGateway,
  type DeliveryRpcMessage,
} from "@/lib/workbuddy/delivery.server";

const STUDENT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_STUDENT_ID = "10000000-0000-4000-8000-000000000002";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_SESSION_ID = "30000000-0000-4000-8000-000000000002";
const MESSAGE_ONE = "40000000-0000-4000-8000-000000000001";
const MESSAGE_TWO = "40000000-0000-4000-8000-000000000002";
const SAME_CREATED_AT = "2026-07-23T09:30:00.000Z";

function message(overrides: Partial<DeliveryRpcMessage> = {}): DeliveryRpcMessage {
  return {
    id: MESSAGE_ONE,
    student_id: STUDENT_ID,
    session_id: SESSION_ID,
    text: "请先确认设备已断电，再继续排查。",
    author_username: "mentor-one",
    created_at: SAME_CREATED_AT,
    first_fetched_at: "2026-07-23T09:31:00.000Z",
    last_fetched_at: "2026-07-23T09:31:00.000Z",
    fetch_count: 1,
    acknowledged_at: null,
    ...overrides,
  };
}

class RecordingDeliveryGateway implements DeliveryGateway {
  fetchCalls: Array<Parameters<DeliveryGateway["fetchPending"]>[0]> = [];
  ackCalls: Array<Parameters<DeliveryGateway["acknowledge"]>[0]> = [];
  fetchResponse: Awaited<ReturnType<DeliveryGateway["fetchPending"]>> = {
    data: { messages: [message()] },
    error: null,
  };
  ackResponse: Awaited<ReturnType<DeliveryGateway["acknowledge"]>> = {
    data: {
      acknowledged: [{ id: MESSAGE_ONE, acknowledged_at: "2026-07-23T09:32:00.000Z" }],
    },
    error: null,
  };

  async fetchPending(args: Parameters<DeliveryGateway["fetchPending"]>[0]) {
    this.fetchCalls.push(args);
    return this.fetchResponse;
  }

  async acknowledge(args: Parameters<DeliveryGateway["acknowledge"]>[0]) {
    this.ackCalls.push(args);
    return this.ackResponse;
  }
}

describe("mentor delivery service", () => {
  test("fetches a bounded ordered page and exposes only the safe DTO", async () => {
    const gateway = new RecordingDeliveryGateway();

    await expect(
      fetchPendingMentorMessages(
        { studentId: STUDENT_ID, sessionId: SESSION_ID, limit: 25 },
        { gateway },
      ),
    ).resolves.toEqual({
      messages: [
        {
          id: MESSAGE_ONE,
          session_id: SESSION_ID,
          text: "请先确认设备已断电，再继续排查。",
          author_username: "mentor-one",
          created_at: SAME_CREATED_AT,
          first_fetched_at: "2026-07-23T09:31:00.000Z",
          last_fetched_at: "2026-07-23T09:31:00.000Z",
          fetch_count: 1,
        },
      ],
      next_cursor: null,
    });
    expect(gateway.fetchCalls).toEqual([
      {
        _student_id: STUDENT_ID,
        _session_id: SESSION_ID,
        _limit: 25,
        _cursor_created_at: null,
        _cursor_id: null,
      },
    ]);
    expect(JSON.stringify(gateway.fetchCalls)).not.toContain("token");
  });

  test("uses a stable (created_at,id) cursor when timestamps match", async () => {
    const gateway = new RecordingDeliveryGateway();
    gateway.fetchResponse = {
      data: {
        messages: [
          message(),
          message({
            id: MESSAGE_TWO,
            first_fetched_at: "2026-07-23T09:31:01.000Z",
            last_fetched_at: "2026-07-23T09:31:01.000Z",
          }),
        ],
      },
      error: null,
    };

    const firstPage = await fetchPendingMentorMessages(
      { studentId: STUDENT_ID, limit: 2 },
      { gateway },
    );
    expect(firstPage.next_cursor).toBeTruthy();
    expect(decodeDeliveryCursor(firstPage.next_cursor!)).toEqual({
      created_at: SAME_CREATED_AT,
      id: MESSAGE_TWO,
    });

    await fetchPendingMentorMessages(
      { studentId: STUDENT_ID, limit: 2, cursor: firstPage.next_cursor! },
      { gateway },
    );
    expect(gateway.fetchCalls[1]).toMatchObject({
      _cursor_created_at: SAME_CREATED_AT,
      _cursor_id: MESSAGE_TWO,
    });
  });

  test("rejects tampered, incomplete, and oversized cursors before the gateway", async () => {
    const gateway = new RecordingDeliveryGateway();
    for (const cursor of [
      "not-base64-json",
      Buffer.from(JSON.stringify({ created_at: SAME_CREATED_AT })).toString("base64url"),
      Buffer.from(
        JSON.stringify({ created_at: SAME_CREATED_AT, id: "not-a-uuid", extra: true }),
      ).toString("base64url"),
      "x".repeat(2_001),
    ]) {
      await expect(
        fetchPendingMentorMessages({ studentId: STUDENT_ID, cursor }, { gateway }),
      ).rejects.toBeInstanceOf(InvalidDeliveryCursorError);
    }
    expect(gateway.fetchCalls).toHaveLength(0);
  });

  test("does not rely on process memory for repeated fetches", async () => {
    const persistentGateway = new RecordingDeliveryGateway();

    const first = await fetchPendingMentorMessages(
      { studentId: STUDENT_ID },
      { gateway: persistentGateway },
    );
    const afterRestart = await fetchPendingMentorMessages(
      { studentId: STUDENT_ID },
      { gateway: persistentGateway },
    );

    expect(afterRestart.messages).toEqual(first.messages);
    expect(persistentGateway.fetchCalls).toHaveLength(2);
  });

  test("acknowledges 1..100 unique IDs and preserves the RPC's first timestamp", async () => {
    const gateway = new RecordingDeliveryGateway();
    gateway.ackResponse = {
      data: {
        acknowledged: [
          { id: MESSAGE_ONE, acknowledged_at: "2026-07-23T09:32:00.000Z" },
          { id: MESSAGE_TWO, acknowledged_at: "2026-07-23T09:32:00.000Z" },
        ],
      },
      error: null,
    };
    const first = await acknowledgeMentorMessages(
      { studentId: STUDENT_ID, messageIds: [MESSAGE_ONE, MESSAGE_TWO] },
      { gateway },
    );
    gateway.ackResponse = { data: { acknowledged: first.acknowledged }, error: null };
    const repeated = await acknowledgeMentorMessages(
      { studentId: STUDENT_ID, messageIds: [MESSAGE_ONE, MESSAGE_TWO] },
      { gateway },
    );

    expect(repeated).toEqual(first);
    expect(gateway.ackCalls).toEqual([
      { _student_id: STUDENT_ID, _message_ids: [MESSAGE_ONE, MESSAGE_TWO] },
      { _student_id: STUDENT_ID, _message_ids: [MESSAGE_ONE, MESSAGE_TWO] },
    ]);

    await expect(
      acknowledgeMentorMessages(
        { studentId: STUDENT_ID, messageIds: [MESSAGE_ONE, MESSAGE_ONE] },
        { gateway },
      ),
    ).rejects.toThrow("INVALID_MESSAGE_IDS");
    await expect(
      acknowledgeMentorMessages({ studentId: STUDENT_ID, messageIds: [] }, { gateway }),
    ).rejects.toThrow("INVALID_MESSAGE_IDS");
    await expect(
      acknowledgeMentorMessages(
        { studentId: STUDENT_ID, messageIds: Array(101).fill(MESSAGE_ONE) },
        { gateway },
      ),
    ).rejects.toThrow("INVALID_MESSAGE_IDS");
  });

  test("maps mixed own/foreign acknowledgement to one non-disclosing ownership error", async () => {
    const gateway = new RecordingDeliveryGateway();
    gateway.ackResponse = {
      data: null,
      error: { code: "P4040", message: "workbuddy_delivery_not_owned" },
    };

    await expect(
      acknowledgeMentorMessages(
        { studentId: STUDENT_ID, messageIds: [MESSAGE_ONE, MESSAGE_TWO] },
        { gateway },
      ),
    ).rejects.toBeInstanceOf(DeliveryOwnershipError);
  });

  test("fails closed when RPC data is malformed or ownership drifts", async () => {
    const gateway = new RecordingDeliveryGateway();
    gateway.fetchResponse = {
      data: {
        messages: [
          message({
            session_id: OTHER_SESSION_ID,
          }),
        ],
      },
      error: null,
    };

    await expect(
      fetchPendingMentorMessages({ studentId: STUDENT_ID, sessionId: SESSION_ID }, { gateway }),
    ).rejects.toBeInstanceOf(DeliveryGatewayError);

    gateway.fetchResponse = {
      data: {
        messages: [message({ student_id: OTHER_STUDENT_ID })],
      },
      error: null,
    };
    await expect(
      fetchPendingMentorMessages({ studentId: STUDENT_ID }, { gateway }),
    ).rejects.toBeInstanceOf(DeliveryGatewayError);
  });

  test("accepts 8000 Unicode characters but fails closed on oversized mentor content", async () => {
    const gateway = new RecordingDeliveryGateway();
    gateway.fetchResponse = {
      data: { messages: [message({ text: "学".repeat(8_000) })] },
      error: null,
    };

    await expect(
      fetchPendingMentorMessages({ studentId: STUDENT_ID }, { gateway }),
    ).resolves.toMatchObject({
      messages: [{ text: "学".repeat(8_000) }],
    });

    gateway.fetchResponse = {
      data: { messages: [message({ text: "😀".repeat(8_000) })] },
      error: null,
    };
    await expect(
      fetchPendingMentorMessages({ studentId: STUDENT_ID }, { gateway }),
    ).resolves.toMatchObject({
      messages: [{ text: "😀".repeat(8_000) }],
    });

    gateway.fetchResponse = {
      data: { messages: [message({ text: "学".repeat(8_001) })] },
      error: null,
    };
    await expect(
      fetchPendingMentorMessages({ studentId: STUDENT_ID }, { gateway }),
    ).rejects.toBeInstanceOf(DeliveryGatewayError);
  });

  test("cursor codec is deterministic and rejects non-canonical data", () => {
    const cursor = encodeDeliveryCursor({ created_at: SAME_CREATED_AT, id: MESSAGE_ONE });
    expect(cursor).toBe(encodeDeliveryCursor({ created_at: SAME_CREATED_AT, id: MESSAGE_ONE }));
    expect(decodeDeliveryCursor(cursor)).toEqual({
      created_at: SAME_CREATED_AT,
      id: MESSAGE_ONE,
    });
  });
});
