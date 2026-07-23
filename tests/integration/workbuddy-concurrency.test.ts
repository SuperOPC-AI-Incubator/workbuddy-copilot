import { createClient } from "@supabase/supabase-js";
import { describe, expect, test } from "vitest";
import type { Database, Json } from "@/integrations/supabase/types";

const testUrl = process.env.CLOUD_INTEGRATION_TEST_URL;
const serviceRoleKey = process.env.CLOUD_INTEGRATION_SERVICE_ROLE_KEY;
const studentId = process.env.CLOUD_INTEGRATION_TEST_STUDENT_ID;
const allowWrites = process.env.CLOUD_INTEGRATION_TEST_ALLOW_WRITES;
const CONCURRENCY_ROUNDS = 3;

const missingConfiguration =
  allowWrites !== "true"
    ? "skipped: CLOUD_INTEGRATION_TEST_ALLOW_WRITES must equal true"
    : !testUrl || !serviceRoleKey || !studentId
      ? "skipped: dedicated cloud integration URL, service key, and student ID are required"
      : null;

function asRecord(value: Json | null): Record<string, Json | undefined> {
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  expect(typeof value).toBe("object");
  return value as Record<string, Json | undefined>;
}

function launchTogether<T>(
  firstRequest: () => PromiseLike<T>,
  secondRequest: () => PromiseLike<T>,
): Promise<[T, T]> {
  let releaseBarrier = () => {};
  const launchBarrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  const pendingRequests = [
    launchBarrier.then(firstRequest),
    launchBarrier.then(secondRequest),
  ] as const;
  releaseBarrier();
  return Promise.all(pendingRequests);
}

describe.skipIf(missingConfiguration !== null)(
  `WorkBuddy concurrent ingest (${missingConfiguration ?? "dedicated test project configured"})`,
  () => {
    test("returns one stable timeline set for the same event and conflicts on a changed hash", async () => {
      const firstClient = createClient<Database>(testUrl!, serviceRoleKey!, {
        auth: { persistSession: false },
      });
      const secondClient = createClient<Database>(testUrl!, serviceRoleKey!, {
        auth: { persistSession: false },
      });
      const rounds = Array.from({ length: CONCURRENCY_ROUNDS }, (_, index) => {
        const eventId = crypto.randomUUID();
        return {
          eventId,
          sourceSessionKey: `vitest-concurrency-${index}-${eventId}`,
        };
      });

      try {
        for (const [roundIndex, round] of rounds.entries()) {
          const args: Database["public"]["Functions"]["ingest_workbuddy_turn"]["Args"] = {
            _event_id: round.eventId,
            _student_id: studentId!,
            _source: "mcp",
            _source_session_key: round.sourceSessionKey,
            _session_title: `Concurrent ingest contract ${roundIndex}`,
            _payload_sha256: "a".repeat(64),
            _prompt: `Exactly one deterministic prompt ${roundIndex}`,
            _reply: `Exactly one deterministic reply ${roundIndex}`,
          };
          const [first, second] = await launchTogether(
            () => firstClient.rpc("ingest_workbuddy_turn", args),
            () => secondClient.rpc("ingest_workbuddy_turn", args),
          );

          expect(first.error).toBeNull();
          expect(second.error).toBeNull();

          const firstResult = asRecord(first.data);
          const secondResult = asRecord(second.data);
          expect([firstResult.duplicate, secondResult.duplicate].sort()).toEqual([false, true]);
          expect(firstResult.session_id).toBe(secondResult.session_id);
          expect(firstResult.prompt_item_id).toBe(secondResult.prompt_item_id);
          expect(firstResult.reply_item_id).toBe(secondResult.reply_item_id);

          const timeline = await firstClient
            .from("timeline_items")
            .select("id, source_event_id", { count: "exact" })
            .eq("source_event_id", round.eventId);
          expect(timeline.error).toBeNull();
          expect(timeline.count).toBe(2);
          expect(timeline.data).toHaveLength(2);

          const conflict = await secondClient.rpc("ingest_workbuddy_turn", {
            ...args,
            _payload_sha256: "b".repeat(64),
          });
          expect(conflict.data).toBeNull();
          expect(conflict.error?.code).toBe("P4090");
        }

        const eventIds = rounds.map((round) => round.eventId);
        const sourceSessionKeys = rounds.map((round) => round.sourceSessionKey);
        const [allTimeline, allEvents, allSessions] = await Promise.all([
          firstClient
            .from("timeline_items")
            .select("id", { count: "exact" })
            .in("source_event_id", eventIds),
          firstClient
            .from("workbuddy_ingest_events")
            .select("event_id", { count: "exact" })
            .in("event_id", eventIds),
          firstClient
            .from("sessions")
            .select("id", { count: "exact" })
            .eq("student_id", studentId!)
            .eq("source", "mcp")
            .in("source_session_key", sourceSessionKeys),
        ]);
        expect(allTimeline.error).toBeNull();
        expect(allEvents.error).toBeNull();
        expect(allSessions.error).toBeNull();
        expect(allTimeline.count).toBe(CONCURRENCY_ROUNDS * 2);
        expect(allEvents.count).toBe(CONCURRENCY_ROUNDS);
        expect(allSessions.count).toBe(CONCURRENCY_ROUNDS);
      } finally {
        const eventIds = rounds.map((round) => round.eventId);
        const sourceSessionKeys = rounds.map((round) => round.sourceSessionKey);
        await firstClient.from("timeline_items").delete().in("source_event_id", eventIds);
        await firstClient.from("workbuddy_ingest_events").delete().in("event_id", eventIds);
        await firstClient
          .from("sessions")
          .delete()
          .eq("student_id", studentId!)
          .eq("source", "mcp")
          .in("source_session_key", sourceSessionKeys);
      }
    }, 60_000);
  },
);
