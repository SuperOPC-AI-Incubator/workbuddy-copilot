const RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000] as const;

export function createMonotonicRefreshController<T>({
  load,
  apply,
  onError = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay),
  clear = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  enqueue = (callback) => queueMicrotask(callback),
}: {
  load: () => Promise<T>;
  apply: (value: T) => void;
  onError?: () => void;
  schedule?: (callback: () => void, delay: number) => unknown;
  clear?: (timer: unknown) => void;
  enqueue?: (callback: () => void) => void;
}) {
  let generation = 0;
  let stopped = false;
  let inFlight = false;
  let queued = false;
  let retryIndex = 0;
  let retryTimer: unknown;
  let currentRequest: Promise<void> | undefined;

  const clearRetry = () => {
    if (retryTimer !== undefined) {
      clear(retryTimer);
      retryTimer = undefined;
    }
  };

  const scheduleRetry = (requestGeneration: number) => {
    if (stopped || requestGeneration !== generation || retryTimer !== undefined) return;
    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS_MS.length - 1);
    retryTimer = schedule(() => {
      retryTimer = undefined;
      if (stopped || requestGeneration !== generation) return;
      void run(requestGeneration);
    }, delay);
  };

  const enqueueRefresh = (requestGeneration: number) => {
    enqueue(() => {
      if (stopped || requestGeneration !== generation) return;
      void run(requestGeneration);
    });
  };

  const run = (requestGeneration: number): Promise<void> => {
    if (stopped || requestGeneration !== generation) return Promise.resolve();
    if (inFlight) {
      queued = true;
      return currentRequest ?? Promise.resolve();
    }
    if (retryTimer !== undefined) return Promise.resolve();

    inFlight = true;
    const request = (async () => {
      let succeeded = false;
      try {
        const value = await load();
        if (!stopped && requestGeneration === generation) {
          apply(value);
          retryIndex = 0;
          clearRetry();
          succeeded = true;
        }
      } catch {
        if (!stopped && requestGeneration === generation) {
          onError();
          scheduleRetry(requestGeneration);
        }
      } finally {
        inFlight = false;
        currentRequest = undefined;
        if (stopped) {
          queued = false;
        } else if (requestGeneration !== generation) {
          if (queued) {
            queued = false;
            enqueueRefresh(generation);
          }
        } else if (succeeded && queued) {
          queued = false;
          enqueueRefresh(requestGeneration);
        }
      }
    })();
    currentRequest = request;
    return request;
  };

  return {
    refresh(): Promise<void> {
      return run(generation);
    },
    invalidate() {
      generation += 1;
      queued = false;
      retryIndex = 0;
      clearRetry();
    },
    stop() {
      stopped = true;
      generation += 1;
      queued = false;
      clearRetry();
    },
  };
}
