export type ComposeDraftOutcome<T> = {
  result: T;
  applied: boolean;
  stale: boolean;
};

export function createComposeRevisionController({
  readText,
  readSessionId,
  applyDraft,
  onDiscard = () => {},
}: {
  readText: () => string;
  readSessionId: () => string | null;
  applyDraft: (draft: string) => void;
  onDiscard?: () => void;
}) {
  let revision = 0;

  const advance = () => {
    revision += 1;
  };

  return {
    noteUserChange: advance,
    noteManualSendStart: advance,
    noteManualSendSuccess: advance,
    invalidateSession: advance,
    invalidateComponent: advance,
    async requestDraft<T>(
      load: () => Promise<T>,
      selectDraft: (result: T) => string | null | undefined,
    ): Promise<ComposeDraftOutcome<T>> {
      const requestRevision = revision;
      const requestText = readText();
      const requestSessionId = readSessionId();
      const result = await load();
      const draft = selectDraft(result);
      if (!draft) return { result, applied: false, stale: false };

      const stale =
        requestSessionId === null ||
        revision !== requestRevision ||
        readText() !== requestText ||
        readSessionId() !== requestSessionId;
      if (stale) {
        onDiscard();
        return { result, applied: false, stale: true };
      }

      advance();
      applyDraft(draft);
      return { result, applied: true, stale: false };
    },
  };
}
