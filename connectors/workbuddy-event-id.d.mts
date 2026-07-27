export const TRUNCATION_MARKER: string;

export function deriveEventId(sessionId: string, userMessageId: string): string;

export function truncateForContract(
  text: string,
  max: number,
): { text: string; truncated: boolean };
