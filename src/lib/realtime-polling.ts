export type RealtimeConnectionStatus =
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED"
  | string;

const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;

export function createRealtimePollingController({
  poll,
  schedule = (callback, delay) => setTimeout(callback, delay),
  clear = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  onPollError = () => {},
  onInvalidate = () => {},
}: {
  poll: () => Promise<void> | void;
  schedule?: (callback: () => void, delay: number) => unknown;
  clear?: (timer: unknown) => void;
  onPollError?: () => void;
  onInvalidate?: () => void;
}) {
  let timer: unknown;
  let retryIndex = 0;
  let subscribed = true;
  let visible = true;
  let stopped = false;
  let inFlight = false;
  let queued = false;
  let generation = 0;

  const clearTimer = () => {
    if (timer !== undefined) {
      clear(timer);
      timer = undefined;
    }
  };

  const shouldPoll = () => !subscribed && visible && !stopped;

  const scheduleNext = () => {
    if (!shouldPoll() || timer !== undefined) return;
    if (inFlight) {
      queued = true;
      return;
    }
    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    timer = schedule(() => {
      timer = undefined;
      if (!shouldPoll()) return;
      if (inFlight) {
        queued = true;
        return;
      }
      const pollGeneration = generation;
      inFlight = true;
      void Promise.resolve(poll())
        .catch(() => onPollError())
        .finally(() => {
          inFlight = false;
          if (pollGeneration === generation) {
            retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS_MS.length - 1);
          }
          if (!shouldPoll()) {
            queued = false;
            return;
          }
          queued = false;
          scheduleNext();
        });
    }, delay);
  };

  return {
    handleStatus(status: RealtimeConnectionStatus) {
      if (stopped) return;
      if (status === "SUBSCRIBED") {
        subscribed = true;
        retryIndex = 0;
        queued = false;
        generation += 1;
        clearTimer();
        onInvalidate();
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        subscribed = false;
        scheduleNext();
      }
    },
    setVisible(nextVisible: boolean) {
      if (stopped || visible === nextVisible) return;
      visible = nextVisible;
      if (!visible) {
        queued = false;
        clearTimer();
      } else {
        scheduleNext();
      }
    },
    stop() {
      stopped = true;
      generation += 1;
      queued = false;
      clearTimer();
      onInvalidate();
    },
  };
}
