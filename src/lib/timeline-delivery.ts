export type TimelineDeliveryRecord = {
  first_fetched_at: string | null;
  last_fetched_at: string | null;
  fetch_count: number;
  acknowledged_at: string | null;
  web_seen_at: string | null;
  failure_count: number;
  last_error_code: string | null;
};

export type TimelineDeliveryDescription = {
  labels: string[];
  pendingCount: number;
  uncertain: boolean;
};

function validTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function describeTimelineDelivery(
  delivery: TimelineDeliveryRecord | null | undefined,
): TimelineDeliveryDescription {
  if (!delivery) {
    return {
      labels: ["历史消息（无投递记录）"],
      pendingCount: 0,
      uncertain: false,
    };
  }

  const firstFetchedAt = validTimestamp(delivery.first_fetched_at);
  const lastFetchedAt = validTimestamp(delivery.last_fetched_at);
  const acknowledgedAt = validTimestamp(delivery.acknowledged_at);
  const webSeenAt = validTimestamp(delivery.web_seen_at);
  const countIsValid = Number.isInteger(delivery.fetch_count) && delivery.fetch_count >= 0;
  const fetchStateIsEmpty =
    delivery.fetch_count === 0 &&
    delivery.first_fetched_at === null &&
    delivery.last_fetched_at === null;
  const fetchStateIsValid =
    countIsValid &&
    delivery.fetch_count > 0 &&
    firstFetchedAt !== null &&
    lastFetchedAt !== null &&
    lastFetchedAt >= firstFetchedAt;
  const acknowledgementIsValid =
    acknowledgedAt !== null &&
    fetchStateIsValid &&
    acknowledgedAt >= (lastFetchedAt ?? Number.POSITIVE_INFINITY);

  const labels: string[] = [];
  if (acknowledgementIsValid) {
    labels.push("WorkBuddy 已送达");
  } else if (fetchStateIsValid) {
    labels.push("WorkBuddy 已获取");
  } else {
    labels.push("待 WorkBuddy 获取");
  }

  if (webSeenAt !== null) labels.push("网页已查看");

  const errorStateIsValid =
    Number.isInteger(delivery.failure_count) &&
    delivery.failure_count >= 0 &&
    ((delivery.failure_count === 0 && delivery.last_error_code === null) ||
      (delivery.failure_count > 0 && Boolean(delivery.last_error_code)));
  if (delivery.failure_count > 0 && errorStateIsValid) {
    labels.push("投递异常（重试中）");
  }

  const uncertain =
    !countIsValid ||
    (!fetchStateIsEmpty && !fetchStateIsValid) ||
    (delivery.acknowledged_at !== null && !acknowledgementIsValid) ||
    (delivery.web_seen_at !== null && webSeenAt === null) ||
    !errorStateIsValid;
  if (uncertain && !labels.includes("投递异常（重试中）")) {
    labels.push("投递状态待确认");
  }

  return {
    labels,
    pendingCount: acknowledgementIsValid ? 0 : 1,
    uncertain,
  };
}

export function pendingMentorDeliveryCount(
  deliveries: Array<TimelineDeliveryRecord | null | undefined>,
): number {
  return deliveries.reduce(
    (count, delivery) => count + describeTimelineDelivery(delivery).pendingCount,
    0,
  );
}
