export type DraftSubmissionOutcome<T> =
  | { started: false }
  | { started: true; succeeded: boolean; result?: T };

export function createDraftSubmissionController({
  readDraft,
  clearDraft,
  onBusyChange = () => {},
}: {
  readDraft: () => string;
  clearDraft: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  let generation = 0;
  let inFlight = false;

  return {
    async submit<T>(
      operation: (capturedDraft: string) => Promise<T>,
      isSuccess: (result: T) => boolean = () => true,
    ): Promise<DraftSubmissionOutcome<T>> {
      if (inFlight) return { started: false };
      const requestGeneration = ++generation;
      const capturedDraft = readDraft();
      inFlight = true;
      onBusyChange(true);
      try {
        const result = await operation(capturedDraft);
        const succeeded = isSuccess(result);
        if (requestGeneration === generation && succeeded && readDraft() === capturedDraft) {
          clearDraft();
        }
        return { started: true, succeeded, result };
      } catch {
        return { started: true, succeeded: false };
      } finally {
        if (requestGeneration === generation) {
          inFlight = false;
          onBusyChange(false);
        }
      }
    },
    invalidate() {
      generation += 1;
      if (inFlight) {
        inFlight = false;
        onBusyChange(false);
      }
    },
    isInFlight() {
      return inFlight;
    },
  };
}
