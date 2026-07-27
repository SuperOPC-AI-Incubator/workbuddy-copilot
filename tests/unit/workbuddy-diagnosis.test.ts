import { afterEach, describe, expect, test, vi } from "vitest";

import type { ReliableWorkbuddyTurn } from "@/lib/workbuddy/contracts";
import {
  ingestWorkbuddyTurn,
  type IngestWorkbuddyTurnGateway,
  type WorkbuddyIngestRpcArgs,
} from "@/lib/workbuddy/events.server";
import {
  createWorkbuddyDiagnosisScheduler,
  type WorkbuddyDiagnosisGateway,
} from "@/lib/workbuddy/diagnosis.server";
import { createWorkbuddyIngestPostHandler } from "@/routes/api/public/workbuddy/ingest";

const STUDENT_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";

type StoredTimelineItem = {
  id: string;
  sessionId: string;
  kind: "prompt" | "reply" | "diagnosis";
  text: string;
  severity: "ok" | "warn" | "error" | null;
  tag: string | null;
  sourceEventId: string;
  eventOrdinal: 0 | 1 | 2;
};

class TemporaryWorkbuddyStore implements IngestWorkbuddyTurnGateway, WorkbuddyDiagnosisGateway {
  readonly timeline: StoredTimelineItem[] = [];
  readonly insertAttempts: Array<{ eventId: string; eventOrdinal: number }> = [];
  private readonly events = new Map<
    string,
    { payloadHash: string; result: Record<string, unknown> }
  >();
  private nextItem = 1;

  async ingestWorkbuddyTurn(args: WorkbuddyIngestRpcArgs) {
    const existing = this.events.get(args._event_id);
    if (existing) {
      if (existing.payloadHash !== args._payload_sha256) {
        return { data: null, error: { code: "P4090", message: "workbuddy_event_conflict" } };
      }
      return { data: { ...existing.result, duplicate: true }, error: null };
    }

    const promptItemId = this.id();
    const replyItemId = this.id();
    this.timeline.push(
      {
        id: promptItemId,
        sessionId: SESSION_ID,
        kind: "prompt",
        text: args._prompt,
        severity: null,
        tag: null,
        sourceEventId: args._event_id,
        eventOrdinal: 0,
      },
      {
        id: replyItemId,
        sessionId: SESSION_ID,
        kind: "reply",
        text: args._reply,
        severity: null,
        tag: null,
        sourceEventId: args._event_id,
        eventOrdinal: 1,
      },
    );

    const diagnosisItemId = args._diagnosis_text ? this.id() : null;
    if (diagnosisItemId) {
      this.timeline.push({
        id: diagnosisItemId,
        sessionId: SESSION_ID,
        kind: "diagnosis",
        text: args._diagnosis_text ?? "",
        severity: args._diagnosis_severity ?? null,
        tag: null,
        sourceEventId: args._event_id,
        eventOrdinal: 2,
      });
    }

    const result = {
      event_id: args._event_id,
      student_id: args._student_id,
      session_id: SESSION_ID,
      prompt_item_id: promptItemId,
      reply_item_id: replyItemId,
      diagnosis_item_id: diagnosisItemId,
      duplicate: false,
    };
    this.events.set(args._event_id, { payloadHash: args._payload_sha256, result });
    return { data: result, error: null };
  }

  async loadRecentContext(sessionId: string, limit: number) {
    return this.timeline
      .filter((item) => item.sessionId === sessionId)
      .slice(-limit)
      .map((item) => ({ kind: item.kind, text: item.text }));
  }

  async insertDiagnosis(input: {
    eventId: string;
    sessionId: string;
    text: string;
    severity: "ok" | "warn" | "error";
    tag: string | null;
  }) {
    this.insertAttempts.push({ eventId: input.eventId, eventOrdinal: 2 });
    if (
      this.timeline.some((item) => item.sourceEventId === input.eventId && item.eventOrdinal === 2)
    ) {
      return { inserted: false };
    }

    this.timeline.push({
      id: this.id(),
      sessionId: input.sessionId,
      kind: "diagnosis",
      text: input.text,
      severity: input.severity,
      tag: input.tag,
      sourceEventId: input.eventId,
      eventOrdinal: 2,
    });
    return { inserted: true };
  }

  diagnoses() {
    return this.timeline.filter((item) => item.kind === "diagnosis");
  }

  private id() {
    return `40000000-0000-4000-8000-${String(this.nextItem++).padStart(12, "0")}`;
  }
}

function reliableTurn(overrides: Partial<ReliableWorkbuddyTurn> = {}): ReliableWorkbuddyTurn {
  return {
    event_id: "20000000-0000-4000-8000-000000000001",
    source: "connector",
    source_session_key: "machine-a/session-42",
    session_title: "自动诊断测试",
    prompt: "我已经连续试了三次，但还是不知道下一步怎么验证。",
    reply: "先写出一个可观察的预期，再只改一个变量进行验证。",
    client_created_at: "2026-07-26T09:00:00.000Z",
    ...overrides,
  };
}

function diagnosisScheduler(
  store: TemporaryWorkbuddyStore,
  overrides: {
    enabled?: boolean;
    available?: boolean;
    sampleRate?: number;
    concurrency?: number;
    diagnose?: Parameters<typeof createWorkbuddyDiagnosisScheduler>[0]["diagnose"];
  } = {},
) {
  return createWorkbuddyDiagnosisScheduler({
    config: {
      enabled: overrides.enabled ?? true,
      sampleRate: overrides.sampleRate ?? 1,
      concurrency: overrides.concurrency ?? 2,
    },
    gateway: store,
    isAIAvailable: () => overrides.available ?? true,
    diagnose:
      overrides.diagnose ??
      (async () => ({
        text: "学员在重复尝试前没有定义可观察预期；先写一条验证标准。",
        severity: "warn",
        tag: "验证闭环",
      })),
    random: () => 0,
  });
}

function handlerWith(
  store: TemporaryWorkbuddyStore,
  scheduler: ReturnType<typeof createWorkbuddyDiagnosisScheduler>,
) {
  return createWorkbuddyIngestPostHandler({
    resolveCredential: async () => ({ studentId: STUDENT_ID }),
    ingestTurn: (input) => ingestWorkbuddyTurn(input, { gateway: store }),
    enqueueDiagnosis: scheduler.enqueue,
  });
}

function request(turn: ReliableWorkbuddyTurn) {
  return new Request("http://localhost/api/public/workbuddy/ingest", {
    method: "POST",
    headers: {
      authorization: "Bearer wb_test_credential",
      "content-type": "application/json",
    },
    body: JSON.stringify(turn),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("automatic WorkBuddy diagnosis through ingest", () => {
  test("persists the fixed LLM diagnosis for a newly ingested turn", async () => {
    const store = new TemporaryWorkbuddyStore();
    const scheduler = diagnosisScheduler(store);
    const response = await handlerWith(store, scheduler)(request(reliableTurn()));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      item_ids: { diagnosis: null },
      duplicate: false,
    });
    await scheduler.onIdle();

    expect(store.diagnoses()).toEqual([
      {
        id: "40000000-0000-4000-8000-000000000003",
        sessionId: SESSION_ID,
        kind: "diagnosis",
        text: "学员在重复尝试前没有定义可观察预期；先写一条验证标准。",
        severity: "warn",
        tag: "验证闭环",
        sourceEventId: "20000000-0000-4000-8000-000000000001",
        eventOrdinal: 2,
      },
    ]);
  });

  test("returns ingest before a slow diagnosis finishes", async () => {
    const store = new TemporaryWorkbuddyStore();
    const started = deferred<void>();
    const release = deferred<{ text: string; severity: "ok"; tag: null }>();
    const scheduler = diagnosisScheduler(store, {
      diagnose: async () => {
        started.resolve();
        return release.promise;
      },
    });

    const response = await handlerWith(store, scheduler)(request(reliableTurn()));
    expect(response.status).toBe(200);
    expect(
      store.timeline.filter((item) => item.kind === "prompt" || item.kind === "reply"),
    ).toHaveLength(2);
    expect(store.diagnoses()).toHaveLength(0);

    await started.promise;
    release.resolve({ text: "已开始分析", severity: "ok", tag: null });
    await scheduler.onIdle();
  });

  test("keeps prompt and reply after an LLM failure without leaking its response", async () => {
    const store = new TemporaryWorkbuddyStore();
    const privateProviderBody = "PRIVATE_PROVIDER_RESPONSE sk-keep-private";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scheduler = diagnosisScheduler(store, {
      diagnose: async () => {
        throw new Error(privateProviderBody);
      },
    });

    await handlerWith(store, scheduler)(request(reliableTurn()));
    await scheduler.onIdle();

    expect(
      store.timeline.filter((item) => item.kind === "prompt" || item.kind === "reply"),
    ).toHaveLength(2);
    expect(store.diagnoses()).toHaveLength(0);
    const observable = JSON.stringify(warn.mock.calls);
    expect(observable).not.toContain(privateProviderBody);
    expect(observable).not.toContain("sk-keep-private");
  });

  test("does not enqueue a second diagnosis for a duplicate ingest event", async () => {
    const store = new TemporaryWorkbuddyStore();
    const diagnose = vi.fn(async () => ({
      text: "第一次诊断",
      severity: "ok" as const,
      tag: null,
    }));
    const scheduler = diagnosisScheduler(store, { diagnose });
    const handler = handlerWith(store, scheduler);

    await handler(request(reliableTurn()));
    await handler(request(reliableTurn()));
    await scheduler.onIdle();

    expect(diagnose).toHaveBeenCalledOnce();
    expect(store.diagnoses()).toHaveLength(1);
  });

  test("quietly skips diagnosis when AI is unavailable", async () => {
    const store = new TemporaryWorkbuddyStore();
    const diagnose = vi.fn(async () => ({ text: "不应生成", severity: "ok" as const, tag: null }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scheduler = diagnosisScheduler(store, { available: false, diagnose });

    const response = await handlerWith(store, scheduler)(request(reliableTurn()));
    await scheduler.onIdle();

    expect(response.status).toBe(200);
    expect(diagnose).not.toHaveBeenCalled();
    expect(store.diagnoses()).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("skips diagnosis when the feature switch is off", async () => {
    const store = new TemporaryWorkbuddyStore();
    const diagnose = vi.fn(async () => ({ text: "不应生成", severity: "ok" as const, tag: null }));
    const scheduler = diagnosisScheduler(store, { enabled: false, diagnose });

    const response = await handlerWith(store, scheduler)(request(reliableTurn()));
    await scheduler.onIdle();

    expect(response.status).toBe(200);
    expect(diagnose).not.toHaveBeenCalled();
    expect(store.diagnoses()).toHaveLength(0);
    expect(scheduler.getMetrics().skippedDisabled).toBe(1);
  });

  test.each([
    { sampleRate: 0, expectedDiagnoses: 0 },
    { sampleRate: 1, expectedDiagnoses: 1 },
  ])("honors an exact sampling rate of $sampleRate", async ({ sampleRate, expectedDiagnoses }) => {
    const store = new TemporaryWorkbuddyStore();
    const scheduler = diagnosisScheduler(store, { sampleRate });

    await handlerWith(store, scheduler)(request(reliableTurn()));
    await scheduler.onIdle();

    expect(store.diagnoses()).toHaveLength(expectedDiagnoses);
  });

  test("queues excess LLM work until a concurrency slot is available", async () => {
    const store = new TemporaryWorkbuddyStore();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<{ text: string; severity: "ok"; tag: null }>();
    let active = 0;
    let maximumActive = 0;
    let invocation = 0;
    const scheduler = diagnosisScheduler(store, {
      concurrency: 1,
      diagnose: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        invocation += 1;
        if (invocation === 1) {
          firstStarted.resolve();
          const result = await releaseFirst.promise;
          active -= 1;
          return result;
        }
        active -= 1;
        return { text: "第二轮", severity: "ok", tag: null };
      },
    });
    const handler = handlerWith(store, scheduler);

    await handler(request(reliableTurn()));
    await firstStarted.promise;
    await handler(request(reliableTurn({ event_id: "20000000-0000-4000-8000-000000000002" })));

    expect(maximumActive).toBe(1);
    expect(store.diagnoses()).toHaveLength(0);
    releaseFirst.resolve({ text: "第一轮", severity: "ok", tag: null });
    await scheduler.onIdle();

    expect(maximumActive).toBe(1);
    expect(store.diagnoses()).toHaveLength(2);
  });

  test("skips the server diagnosis when ingest already persisted the client diagnosis", async () => {
    const store = new TemporaryWorkbuddyStore();
    const diagnose = vi.fn(async () => ({
      text: "不应生成",
      severity: "warn" as const,
      tag: "噪音",
    }));
    const scheduler = diagnosisScheduler(store, { diagnose });

    const response = await handlerWith(
      store,
      scheduler,
    )(
      request(
        reliableTurn({
          diagnosis: { text: "客户端已分析", severity: "warn" },
        }),
      ),
    );
    await scheduler.onIdle();

    expect(response.status).toBe(200);
    expect(diagnose).not.toHaveBeenCalled();
    expect(store.diagnoses()).toHaveLength(1);
    expect(store.diagnoses()[0]).toMatchObject({ text: "客户端已分析", eventOrdinal: 2 });
    expect(store.insertAttempts).toHaveLength(0);
  });

  test("relies on the ordinal-2 unique insert when the same event is diagnosed concurrently", async () => {
    const store = new TemporaryWorkbuddyStore();
    const diagnose = vi.fn(async () => ({
      text: "同一轮诊断",
      severity: "warn" as const,
      tag: null,
    }));
    const scheduler = diagnosisScheduler(store, { concurrency: 2, diagnose });
    const job = {
      eventId: "20000000-0000-4000-8000-000000000001",
      sessionId: SESSION_ID,
      prompt: "同一问题",
      reply: "同一回复",
    };

    scheduler.enqueue(job);
    scheduler.enqueue(job);
    await scheduler.onIdle();

    expect(diagnose).toHaveBeenCalledTimes(2);
    expect(store.insertAttempts).toHaveLength(2);
    expect(store.diagnoses()).toHaveLength(1);
  });
});
