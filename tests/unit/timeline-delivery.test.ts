import { describe, expect, test } from "vitest";

import { describeTimelineDelivery, pendingMentorDeliveryCount } from "@/lib/timeline-delivery";

const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "40000000-0000-4000-8000-000000000001";
const FETCHED_AT = "2026-07-24T01:00:00.000Z";
const ACKED_AT = "2026-07-24T01:01:00.000Z";
const WEB_SEEN_AT = "2026-07-24T01:02:00.000Z";

function delivery(
  overrides: Partial<Parameters<typeof describeTimelineDelivery>[0]> = {},
): Parameters<typeof describeTimelineDelivery>[0] {
  return {
    first_fetched_at: null,
    last_fetched_at: null,
    fetch_count: 0,
    acknowledged_at: null,
    web_seen_at: null,
    failure_count: 0,
    last_error_code: null,
    ...overrides,
  };
}

describe("timeline delivery status", () => {
  test("maps pending, fetched, and acknowledged with exact priority labels", () => {
    expect(describeTimelineDelivery(delivery())).toEqual({
      labels: ["待 WorkBuddy 获取"],
      pendingCount: 1,
      uncertain: false,
    });
    expect(
      describeTimelineDelivery(
        delivery({
          first_fetched_at: FETCHED_AT,
          last_fetched_at: FETCHED_AT,
          fetch_count: 2,
        }),
      ),
    ).toEqual({
      labels: ["WorkBuddy 已获取"],
      pendingCount: 1,
      uncertain: false,
    });
    expect(
      describeTimelineDelivery(
        delivery({
          first_fetched_at: FETCHED_AT,
          last_fetched_at: FETCHED_AT,
          fetch_count: 2,
          acknowledged_at: ACKED_AT,
        }),
      ),
    ).toEqual({
      labels: ["WorkBuddy 已送达"],
      pendingCount: 0,
      uncertain: false,
    });
  });

  test("composes web visibility without overwriting WorkBuddy delivery", () => {
    expect(
      describeTimelineDelivery(
        delivery({
          first_fetched_at: FETCHED_AT,
          last_fetched_at: FETCHED_AT,
          fetch_count: 1,
          acknowledged_at: ACKED_AT,
          web_seen_at: WEB_SEEN_AT,
        }),
      ),
    ).toEqual({
      labels: ["WorkBuddy 已送达", "网页已查看"],
      pendingCount: 0,
      uncertain: false,
    });
    expect(describeTimelineDelivery(delivery({ web_seen_at: WEB_SEEN_AT })).labels).toEqual([
      "待 WorkBuddy 获取",
      "网页已查看",
    ]);
  });

  test("fails safe for legacy, malformed, and out-of-order timestamps", () => {
    expect(describeTimelineDelivery(null)).toEqual({
      labels: ["历史消息（无投递记录）"],
      pendingCount: 0,
      uncertain: false,
    });
    expect(
      describeTimelineDelivery(
        delivery({
          first_fetched_at: "invalid",
          last_fetched_at: FETCHED_AT,
          fetch_count: 1,
          acknowledged_at: ACKED_AT,
        }),
      ),
    ).toEqual({
      labels: ["待 WorkBuddy 获取", "投递状态待确认"],
      pendingCount: 1,
      uncertain: true,
    });
    expect(
      describeTimelineDelivery(
        delivery({
          first_fetched_at: ACKED_AT,
          last_fetched_at: FETCHED_AT,
          fetch_count: 1,
          acknowledged_at: FETCHED_AT,
        }),
      ).labels,
    ).not.toContain("WorkBuddy 已送达");
  });

  test("requires acknowledgement to be at or after the last fetch", () => {
    const result = describeTimelineDelivery(
      delivery({
        first_fetched_at: FETCHED_AT,
        last_fetched_at: WEB_SEEN_AT,
        fetch_count: 2,
        acknowledged_at: ACKED_AT,
      }),
    );

    expect(result).toEqual({
      labels: ["WorkBuddy 已获取", "投递状态待确认"],
      pendingCount: 1,
      uncertain: true,
    });
  });

  test("reports generic retry state without exposing an internal error code", () => {
    const result = describeTimelineDelivery(
      delivery({ failure_count: 3, last_error_code: "SECRET_GATEWAY_DETAIL" }),
    );
    expect(result.labels).toEqual(["待 WorkBuddy 获取", "投递异常（重试中）"]);
    expect(JSON.stringify(result)).not.toContain("SECRET_GATEWAY_DETAIL");
  });

  test("counts pending mentor messages only when acknowledgement is absent", () => {
    expect(
      pendingMentorDeliveryCount([
        delivery(),
        delivery({
          first_fetched_at: FETCHED_AT,
          last_fetched_at: FETCHED_AT,
          fetch_count: 1,
          acknowledged_at: ACKED_AT,
        }),
        null,
      ]),
    ).toBe(1);
  });

  test("counts malformed and out-of-order acknowledgements as pending", () => {
    expect(
      pendingMentorDeliveryCount([
        delivery({
          first_fetched_at: FETCHED_AT,
          last_fetched_at: WEB_SEEN_AT,
          fetch_count: 2,
          acknowledged_at: ACKED_AT,
        }),
        delivery({
          first_fetched_at: FETCHED_AT,
          last_fetched_at: FETCHED_AT,
          fetch_count: 1,
          acknowledged_at: "not-a-timestamp",
        }),
        null,
      ]),
    ).toBe(2);
  });
});
