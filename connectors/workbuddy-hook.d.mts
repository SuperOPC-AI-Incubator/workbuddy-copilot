import type { WorkbuddyTurnEvent } from "./workbuddy-transcript.d.mts";

export const MAX_TAIL_BYTES: number;
export const ENQUEUE_TIMEOUT_MS: number;

export type HookResult = {
  exitCode: 0;
  ok: boolean;
  reason: string | null;
  eventId?: string;
  event?: WorkbuddyTurnEvent;
  eventFile?: string;
  spawned?: { command: string; args: string[]; env: Record<string, string | undefined> };
};

export function runHook(input?: {
  stdinText?: string;
  env?: Record<string, string | undefined>;
  fs?: unknown;
  spawn?: unknown;
  log?: (message: string) => void;
  execPath?: string;
  temporaryDirectory?: string;
  timeoutMs?: number;
}): Promise<HookResult>;
