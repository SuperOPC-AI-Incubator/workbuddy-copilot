import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createRealtimePollingController } from "@/lib/realtime-polling";

describe("Realtime polling fallback", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("polls once at 5, 10, 20, then 30 second capped intervals", async () => {
    const poll = vi.fn(async () => {});
    const controller = createRealtimePollingController({ poll });

    controller.handleStatus("CHANNEL_ERROR");
    controller.handleStatus("TIMED_OUT");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(poll).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);
  });

  test("stops and clears immediately when Realtime recovers", async () => {
    const poll = vi.fn(async () => {});
    const controller = createRealtimePollingController({ poll });
    controller.handleStatus("CLOSED");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(1);

    controller.handleStatus("SUBSCRIBED");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  test("pauses while hidden, resumes once visible, and cleans up on stop", async () => {
    const poll = vi.fn(async () => {});
    const controller = createRealtimePollingController({ poll });
    controller.handleStatus("CHANNEL_ERROR");
    controller.setVisible(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).not.toHaveBeenCalled();

    controller.setVisible(true);
    controller.setVisible(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(1);

    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("never overlaps polls during repeated errors and visibility changes", async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const poll = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
    const controller = createRealtimePollingController({ poll });

    controller.handleStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(1);

    controller.handleStatus("TIMED_OUT");
    controller.setVisible(false);
    controller.setVisible(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  test("SUBSCRIBED invalidates an in-flight poll and its finally cannot restart backoff", async () => {
    let resolvePoll!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolvePoll = resolve;
    });
    const onInvalidate = vi.fn();
    const poll = vi.fn(() => pending);
    const controller = createRealtimePollingController({ poll, onInvalidate });

    controller.handleStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledOnce();

    controller.handleStatus("SUBSCRIBED");
    expect(onInvalidate).toHaveBeenCalledOnce();
    resolvePoll();
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledOnce();
  });

  test("an old poll completion cannot swallow a disconnect that follows recovery", async () => {
    let resolveOldPoll!: () => void;
    const oldPoll = new Promise<void>((resolve) => {
      resolveOldPoll = resolve;
    });
    const poll = vi.fn().mockReturnValueOnce(oldPoll).mockResolvedValue(undefined);
    const controller = createRealtimePollingController({ poll });

    controller.handleStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledOnce();

    controller.handleStatus("SUBSCRIBED");
    controller.handleStatus("CHANNEL_ERROR");
    expect(vi.getTimerCount()).toBe(0);

    resolveOldPoll();
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(poll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(3);
  });
});
