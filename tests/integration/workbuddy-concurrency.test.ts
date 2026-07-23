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
  `WorkBuddy cloud concurrency (${missingConfiguration ?? "dedicated test project configured"})`,
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

    test("allows only one active credential during concurrent create-first requests", async () => {
      const firstClient = createClient<Database>(testUrl!, serviceRoleKey!, {
        auth: { persistSession: false },
      });
      const secondClient = createClient<Database>(testUrl!, serviceRoleKey!, {
        auth: { persistSession: false },
      });
      const student = await firstClient
        .from("students")
        .select("user_id")
        .eq("id", studentId!)
        .single();
      expect(student.error).toBeNull();
      expect(student.data?.user_id).toBeTruthy();
      const userId = student.data!.user_id!;
      const issuedHashes: string[] = [];

      const randomHash = () =>
        Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");

      try {
        await firstClient.rpc("revoke_workbuddy_credential", { _user_id: userId });

        for (let round = 0; round < CONCURRENCY_ROUNDS; round += 1) {
          const firstHash = randomHash();
          const secondHash = randomHash();
          issuedHashes.push(firstHash, secondHash);
          const [first, second] = await launchTogether(
            () =>
              firstClient.rpc("issue_workbuddy_credential", {
                _user_id: userId,
                _token_hash: firstHash,
                _token_prefix: `wb_first${round}`,
                _rotate: false,
              }),
            () =>
              secondClient.rpc("issue_workbuddy_credential", {
                _user_id: userId,
                _token_hash: secondHash,
                _token_prefix: `wb_second${round}`,
                _rotate: false,
              }),
          );

          expect([first.error?.code ?? null, second.error?.code ?? null].sort()).toEqual([
            null,
            "P4090",
          ]);
          const active = await firstClient
            .from("workbuddy_credentials")
            .select("token_hash", { count: "exact" })
            .eq("student_id", studentId!)
            .eq("status", "active");
          expect(active.error).toBeNull();
          expect(active.count).toBe(1);
          expect([firstHash, secondHash]).toContain(active.data?.[0]?.token_hash);

          await firstClient.rpc("revoke_workbuddy_credential", { _user_id: userId });
        }
      } finally {
        await firstClient
          .from("workbuddy_credentials")
          .delete()
          .eq("student_id", studentId!)
          .in("token_hash", issuedHashes);
      }
    }, 60_000);

    test("serializes fetch and reverse-UUID acknowledgement without a delivery deadlock", async () => {
      const firstClient = createClient<Database>(testUrl!, serviceRoleKey!, {
        auth: { persistSession: false },
      });
      const secondClient = createClient<Database>(testUrl!, serviceRoleKey!, {
        auth: { persistSession: false },
      });
      const eventId = crypto.randomUUID();
      const sourceSessionKey = `vitest-delivery-lock-${eventId}`;
      const uuidStem = eventId.slice(0, -12);
      const earlierHighId = `${uuidStem}ffffffffffff`;
      const laterLowId = `${uuidStem}000000000001`;
      let sessionId: string | null = null;

      try {
        const staff = await firstClient
          .from("staff_accounts")
          .select("user_id")
          .eq("is_active", true)
          .eq("must_change_password", false)
          .limit(1)
          .single();
        expect(staff.error).toBeNull();
        expect(staff.data?.user_id).toBeTruthy();

        const ingest = await firstClient.rpc("ingest_workbuddy_turn", {
          _event_id: eventId,
          _student_id: studentId!,
          _source: "mcp",
          _source_session_key: sourceSessionKey,
          _session_title: "Delivery lock order contract",
          _payload_sha256: "c".repeat(64),
          _prompt: "Create an isolated session for delivery locking",
          _reply: "The session is ready",
        });
        expect(ingest.error).toBeNull();
        sessionId = asRecord(ingest.data).session_id as string;
        expect(sessionId).toBeTruthy();

        const baseTime = Date.now() - 10_000;
        const inserted = await firstClient.from("timeline_items").insert([
          {
            id: earlierHighId,
            session_id: sessionId,
            kind: "mentor",
            text: "Earlier created_at, higher UUID",
            author_id: staff.data!.user_id,
            created_at: new Date(baseTime).toISOString(),
          },
          {
            id: laterLowId,
            session_id: sessionId,
            kind: "mentor",
            text: "Later created_at, lower UUID",
            author_id: staff.data!.user_id,
            created_at: new Date(baseTime + 1_000).toISOString(),
          },
        ]);
        expect(inserted.error).toBeNull();
        expect(earlierHighId > laterLowId).toBe(true);

        const [fetched, acknowledged] = await launchTogether(
          () =>
            firstClient.rpc("fetch_workbuddy_mentor_messages", {
              _student_id: studentId!,
              _session_id: sessionId,
              _limit: 100,
              _cursor_created_at: null,
              _cursor_id: null,
            }),
          () =>
            secondClient.rpc("ack_workbuddy_mentor_messages", {
              _student_id: studentId!,
              _message_ids: [laterLowId, earlierHighId],
            }),
        );

        expect(fetched.error).toBeNull();
        expect(acknowledged.error).toBeNull();
        const fetchedIds = ((asRecord(fetched.data).messages ?? []) as Json[]).map(
          (message) => (message as Record<string, Json>).id,
        );
        expect([[], [earlierHighId, laterLowId]]).toContainEqual(fetchedIds);

        const deliveries = await firstClient
          .from("mentor_message_deliveries")
          .select("message_id, fetch_count, first_fetched_at, acknowledged_at")
          .in("message_id", [earlierHighId, laterLowId])
          .order("message_id");
        expect(deliveries.error).toBeNull();
        expect(deliveries.data).toHaveLength(2);
        expect(deliveries.data?.every(({ acknowledged_at }) => acknowledged_at !== null)).toBe(
          true,
        );
        const fetchCounts = deliveries.data?.map(({ fetch_count }) => fetch_count) ?? [];
        expect(new Set(fetchCounts).size).toBe(1);
        expect([0, 1]).toContain(fetchCounts[0]);
        expect(
          deliveries.data?.every(({ fetch_count, first_fetched_at }) =>
            fetch_count === 0 ? first_fetched_at === null : first_fetched_at !== null,
          ),
        ).toBe(true);
      } finally {
        await firstClient.from("timeline_items").delete().in("id", [earlierHighId, laterLowId]);
        await firstClient.from("timeline_items").delete().eq("source_event_id", eventId);
        await firstClient.from("workbuddy_ingest_events").delete().eq("event_id", eventId);
        if (sessionId) {
          await firstClient
            .from("sessions")
            .delete()
            .eq("id", sessionId)
            .eq("student_id", studentId!);
        }
      }
    }, 60_000);

    test("completes a fetch racing a timeline cascade delete without a lock cycle", async () => {
      const fetchClient = createClient<Database>(testUrl!, serviceRoleKey!, {
        auth: { persistSession: false },
      });
      const deleteClient = createClient<Database>(testUrl!, serviceRoleKey!, {
        auth: { persistSession: false },
      });
      const eventId = crypto.randomUUID();
      const sourceSessionKey = `vitest-delivery-cascade-${eventId}`;
      const messageId = crypto.randomUUID();
      let sessionId: string | null = null;

      try {
        const staff = await fetchClient
          .from("staff_accounts")
          .select("user_id")
          .eq("is_active", true)
          .eq("must_change_password", false)
          .limit(1)
          .single();
        expect(staff.error).toBeNull();
        expect(staff.data?.user_id).toBeTruthy();

        const ingest = await fetchClient.rpc("ingest_workbuddy_turn", {
          _event_id: eventId,
          _student_id: studentId!,
          _source: "mcp",
          _source_session_key: sourceSessionKey,
          _session_title: "Delivery cascade lock contract",
          _payload_sha256: "d".repeat(64),
          _prompt: "Create an isolated session for a cascade race",
          _reply: "The session is ready",
        });
        expect(ingest.error).toBeNull();
        sessionId = asRecord(ingest.data).session_id as string;
        expect(sessionId).toBeTruthy();

        const inserted = await fetchClient.from("timeline_items").insert({
          id: messageId,
          session_id: sessionId,
          kind: "mentor",
          text: "Message deleted while a fetch starts",
          author_id: staff.data!.user_id,
        });
        expect(inserted.error).toBeNull();

        const [fetched, deleted] = await launchTogether(
          () =>
            fetchClient.rpc("fetch_workbuddy_mentor_messages", {
              _student_id: studentId!,
              _session_id: sessionId,
              _limit: 100,
              _cursor_created_at: null,
              _cursor_id: null,
            }),
          () => deleteClient.from("timeline_items").delete().eq("id", messageId),
        );

        expect(fetched.error).toBeNull();
        expect(deleted.error).toBeNull();
        const fetchedIds = ((asRecord(fetched.data).messages ?? []) as Json[]).map(
          (message) => (message as Record<string, Json>).id,
        );
        expect([[], [messageId]]).toContainEqual(fetchedIds);

        const [timeline, deliveries] = await Promise.all([
          fetchClient.from("timeline_items").select("id").eq("id", messageId),
          fetchClient
            .from("mentor_message_deliveries")
            .select("message_id")
            .eq("message_id", messageId),
        ]);
        expect(timeline.error).toBeNull();
        expect(deliveries.error).toBeNull();
        expect(timeline.data).toEqual([]);
        expect(deliveries.data).toEqual([]);
      } finally {
        await fetchClient.from("timeline_items").delete().eq("id", messageId);
        await fetchClient.from("timeline_items").delete().eq("source_event_id", eventId);
        await fetchClient.from("workbuddy_ingest_events").delete().eq("event_id", eventId);
        if (sessionId) {
          await fetchClient
            .from("sessions")
            .delete()
            .eq("id", sessionId)
            .eq("student_id", studentId!);
        }
      }
    }, 60_000);
  },
);
