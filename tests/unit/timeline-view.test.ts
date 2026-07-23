import { describe, expect, test } from "vitest";

import {
  TimelineViewError,
  loadTimelineDeliveryView,
  type TimelineSnapshotGateway,
} from "@/lib/timeline-view.server";

const ACTOR_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "40000000-0000-4000-8000-000000000001";

class SnapshotGateway implements TimelineSnapshotGateway {
  calls = 0;
  data: unknown = {
    session_id: SESSION_ID,
    items: [
      {
        timeline: {
          id: MESSAGE_ID,
          session_id: SESSION_ID,
          kind: "mentor",
          text: "请继续。",
          severity: null,
          tag: null,
          author_username: "Michael",
          created_at: "2026-07-24T00:00:00.000Z",
        },
        delivery: {
          message_id: MESSAGE_ID,
          session_id: SESSION_ID,
          first_fetched_at: null,
          last_fetched_at: null,
          fetch_count: 0,
          acknowledged_at: null,
          web_seen_at: null,
          failure_count: 0,
          last_error_code: null,
        },
      },
    ],
  };

  async snapshot() {
    this.calls += 1;
    return { data: this.data, error: null };
  }
}

describe("timeline delivery snapshot", () => {
  test("uses exactly one joined gateway call and projects one coherent snapshot", async () => {
    const gateway = new SnapshotGateway();
    const result = await loadTimelineDeliveryView(
      { actorUserId: ACTOR_ID, sessionId: SESSION_ID },
      { gateway },
    );

    expect(gateway.calls).toBe(1);
    expect(result.timeline).toHaveLength(1);
    expect(result.deliveries).toHaveLength(1);
    expect(result.timeline[0]?.id).toBe(result.deliveries[0]?.message_id);
  });

  test("fails closed on malformed or mismatched joined DTOs", async () => {
    const gateway = new SnapshotGateway();
    gateway.data = {
      session_id: SESSION_ID,
      items: [
        {
          timeline: {
            id: MESSAGE_ID,
            session_id: SESSION_ID,
            kind: "mentor",
            text: "message",
            severity: null,
            tag: null,
            author_username: "Michael",
            created_at: "2026-07-24T00:00:00.000Z",
          },
          delivery: { message_id: "not-the-same-message" },
        },
      ],
    };

    await expect(
      loadTimelineDeliveryView({ actorUserId: ACTOR_ID, sessionId: SESSION_ID }, { gateway }),
    ).rejects.toBeInstanceOf(TimelineViewError);
    expect(gateway.calls).toBe(1);
  });
});
