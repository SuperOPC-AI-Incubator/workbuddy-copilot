export type VisibilityObserverEntry = {
  target: object;
  isIntersecting: boolean;
  intersectionRatio: number;
};

type VisibilityObserver = {
  observe(element: object): void;
  unobserve(element: object): void;
  disconnect(): void;
};

type VisibleCandidate = {
  messageId: string;
  sessionId: string;
  kind: string;
};

export function createWebSeenVisibilityController({
  role,
  sessionId,
  isDocumentVisible,
  markSeen,
  createObserver,
  onMarkError = () => {},
}: {
  role: "student" | "mentor" | null;
  sessionId: string | null;
  isDocumentVisible: () => boolean;
  markSeen: (messageIds: string[]) => Promise<void> | void;
  createObserver: (
    callback: (entries: VisibilityObserverEntry[]) => void,
    options: { threshold: number },
  ) => VisibilityObserver;
  onMarkError?: () => void;
}) {
  const candidates = new Map<object, VisibleCandidate>();
  const visibleElements = new Set<object>();
  const markedIds = new Set<string>();
  let stopped = false;

  const flush = () => {
    if (stopped || role !== "student" || !sessionId || !isDocumentVisible()) return;
    const ids = [
      ...new Set(
        [...visibleElements]
          .map((element) => candidates.get(element))
          .filter(
            (candidate): candidate is VisibleCandidate =>
              candidate?.kind === "mentor" && candidate.sessionId === sessionId,
          )
          .map((candidate) => candidate.messageId)
          .filter((messageId) => !markedIds.has(messageId)),
      ),
    ];
    if (ids.length === 0) return;
    ids.forEach((messageId) => markedIds.add(messageId));
    void Promise.resolve(markSeen(ids)).catch(() => {
      ids.forEach((messageId) => markedIds.delete(messageId));
      onMarkError();
    });
  };

  const observer = createObserver(
    (entries) => {
      if (stopped) return;
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          visibleElements.add(entry.target);
        } else {
          visibleElements.delete(entry.target);
        }
      }
      flush();
    },
    { threshold: 0.5 },
  );

  return {
    observe(candidate: VisibleCandidate, element: object) {
      if (
        stopped ||
        role !== "student" ||
        candidate.kind !== "mentor" ||
        candidate.sessionId !== sessionId
      ) {
        return;
      }
      candidates.set(element, candidate);
      observer.observe(element);
    },
    unobserve(element: object) {
      candidates.delete(element);
      visibleElements.delete(element);
      observer.unobserve(element);
    },
    handleDocumentVisibility() {
      flush();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      candidates.clear();
      visibleElements.clear();
      observer.disconnect();
    },
  };
}
