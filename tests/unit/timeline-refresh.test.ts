import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRealtimePollingController } from "@/lib/realtime-polling";
import { createMonotonicRefreshController } from "@/lib/timeline-refresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("single-flight timeline refresh scheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("retries a failed Realtime event after five seconds and stops retrying after success", async () => {
    const failed = deferred<string>();
    const recovered = deferred<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(recovered.promise);
    const applied: string[] = [];
    const refresh = createMonotonicRefreshController({
      load,
      apply: (value) => applied.push(value),
    });

    const eventRefresh = refresh.refresh();
    failed.reject(new Error("temporary snapshot failure"));
    await eventRefresh;

    expect(load).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(load).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    recovered.resolve("authoritative-after-retry");
    await flushMicrotasks();

    expect(applied).toEqual(["authoritative-after-retry"]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("uses capped 5, 10, 20, then 30 second retry backoff until a refresh succeeds", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("one"))
      .mockRejectedValueOnce(new Error("two"))
      .mockRejectedValueOnce(new Error("three"))
      .mockRejectedValueOnce(new Error("four"))
      .mockRejectedValueOnce(new Error("five"))
      .mockResolvedValue("recovered");
    const applied: string[] = [];
    const refresh = createMonotonicRefreshController({
      load,
      apply: (value) => applied.push(value),
    });

    await refresh.refresh();
    let expectedCalls = 1;
    for (const delay of [5_000, 10_000, 20_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(load).toHaveBeenCalledTimes(expectedCalls);
      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expectedCalls += 1;
    }

    expect(load).toHaveBeenCalledTimes(6);
    expect(applied).toEqual(["recovered"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("coalesces many events into one in-flight and one queued authoritative refresh", async () => {
    const first = deferred<string>();
    const queued = deferred<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(queued.promise);
    const applied: string[] = [];
    const refresh = createMonotonicRefreshController({
      load,
      apply: (value) => applied.push(value),
    });

    const firstRequest = refresh.refresh();
    void refresh.refresh();
    void refresh.refresh();
    void refresh.refresh();
    expect(load).toHaveBeenCalledOnce();

    first.resolve("first-snapshot");
    await firstRequest;
    await flushMicrotasks();
    expect(load).toHaveBeenCalledTimes(2);

    queued.resolve("coalesced-event-snapshot");
    await flushMicrotasks();
    expect(load).toHaveBeenCalledTimes(2);
    expect(applied).toEqual(["first-snapshot", "coalesced-event-snapshot"]);
  });

  test("queues an event arriving during a refresh and applies its follow-up snapshot", async () => {
    const beforeEvent = deferred<string[]>();
    const afterEvent = deferred<string[]>();
    const load = vi
      .fn<() => Promise<string[]>>()
      .mockReturnValueOnce(beforeEvent.promise)
      .mockReturnValueOnce(afterEvent.promise);
    const applied: string[][] = [];
    const refresh = createMonotonicRefreshController({
      load,
      apply: (value) => applied.push(value),
    });

    const initial = refresh.refresh();
    void refresh.refresh();
    expect(load).toHaveBeenCalledOnce();

    beforeEvent.resolve(["historical-message"]);
    await initial;
    await flushMicrotasks();
    expect(load).toHaveBeenCalledTimes(2);

    afterEvent.resolve(["historical-message", "realtime-message"]);
    await flushMicrotasks();
    expect(applied.at(-1)).toEqual(["historical-message", "realtime-message"]);
  });

  test("stop cancels a pending retry and prevents later in-flight results from applying", async () => {
    const failed = deferred<string>();
    const load = vi.fn<() => Promise<string>>().mockReturnValue(failed.promise);
    const apply = vi.fn();
    const refresh = createMonotonicRefreshController({ load, apply });

    const request = refresh.refresh();
    failed.reject(new Error("offline"));
    await request;
    expect(vi.getTimerCount()).toBe(1);

    refresh.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });

  test("a disconnect poll and a simultaneous Realtime event never start two snapshot loads", async () => {
    const eventLoad = deferred<string>();
    const queuedLoad = deferred<string>();
    const requests = [eventLoad, queuedLoad];
    let activeLoads = 0;
    let maxActiveLoads = 0;
    const load = vi.fn(async () => {
      const request = requests[load.mock.calls.length - 1];
      activeLoads += 1;
      maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
      try {
        return await request.promise;
      } finally {
        activeLoads -= 1;
      }
    });
    const refresh = createMonotonicRefreshController({ load, apply: () => {} });
    const polling = createRealtimePollingController({
      poll: () => refresh.refresh(),
    });

    const eventRequest = refresh.refresh();
    polling.handleStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledOnce();
    expect(maxActiveLoads).toBe(1);

    eventLoad.resolve("event");
    await eventRequest;
    await flushMicrotasks();
    expect(load).toHaveBeenCalledTimes(2);
    expect(maxActiveLoads).toBe(1);

    queuedLoad.resolve("poll-coalesced-after-event");
    await flushMicrotasks();
    expect(maxActiveLoads).toBe(1);
    polling.stop();
    refresh.stop();
  });

  test("invalidate makes an old session result stale and queues the new generation", async () => {
    const oldSession = deferred<string>();
    const newSession = deferred<string>();
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(oldSession.promise)
      .mockReturnValueOnce(newSession.promise);
    const applied: string[] = [];
    const refresh = createMonotonicRefreshController({
      load,
      apply: (value) => applied.push(value),
    });

    const oldRequest = refresh.refresh();
    refresh.invalidate();
    void refresh.refresh();
    expect(load).toHaveBeenCalledOnce();

    oldSession.resolve("old-session");
    await oldRequest;
    await flushMicrotasks();
    expect(applied).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);

    newSession.resolve("new-session");
    await flushMicrotasks();
    expect(applied).toEqual(["new-session"]);
  });
});
