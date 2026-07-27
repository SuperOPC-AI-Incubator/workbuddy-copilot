export type ConnectorPaths = {
  root: string;
  config: string;
  outbox: string;
  claims: string;
  quarantine: string;
  renderLedger: string;
};

export class ConnectorError extends Error {
  readonly code: string;
}

export const LIVE_PID_GRACE_MS: number;
export const CONNECTOR_VERSION: string;

export type WorkbuddyConnector = {
  apiUrl: string | null;
  paths: ConnectorPaths;
  configure(input: { apiUrl: string; token: string }): Promise<void>;
  enqueueEvent(event: unknown): Promise<{ queued: boolean; eventId: string }>;
  syncEventFile(filePath: string): Promise<Record<string, number>>;
  flush(): Promise<Record<string, number>>;
  fetchMessages(input: { sessionId?: string }): Promise<{
    notice: string;
    messages: Array<{ id: string; session_id: string; text: string }>;
    next_cursor: string | null;
  }>;
  acknowledge(messageIds: string[]): Promise<unknown>;
  pendingMessages(): Promise<
    Array<{
      id: string;
      session_id: string;
      text: string;
      author_username: string | null;
      created_at: string;
      rendered_at: string;
      shell_displayed_at: string | null;
      acked_at: string | null;
    }>
  >;
  markMessagesDisplayed(messageIds: string[]): Promise<{ accepted: string[] }>;
  pendingAcknowledgements(): Promise<string[]>;
  status(): Promise<unknown>;
  testConnection(): Promise<unknown>;
};

export function createWorkbuddyConnector(options?: {
  stateDir?: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  randomUUID?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  jitter?: () => number;
  allowInsecureLocalhost?: boolean;
  timeoutMs?: number;
  retryCount?: number;
  claimStaleMs?: number;
  lockStaleMs?: number;
  livePidGraceMs?: number;
  lockAttempts?: number;
  maximumResponseBytes?: number;
  onDurabilityEvent?: (event: string) => void;
  beforeAckLedgerCommit?: () => Promise<void>;
  beforeLockRelease?: (path: string, ownerNonce: string) => Promise<void>;
  fsyncDirectoryImpl?: (path: string) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}): WorkbuddyConnector;

export type WorkbuddyIpcServer = {
  endpoint: string;
  capabilityTokenPath: string;
  close(): Promise<void>;
};

export function startWorkbuddyIpcServer(options?: {
  connector?: WorkbuddyConnector;
  endpoint?: string;
  pollIntervalMs?: number;
  ackRetryDelayMs?: number;
}): Promise<WorkbuddyIpcServer>;

export function runCli(
  argv: string[],
  options?: {
    connector?: WorkbuddyConnector;
    stdout?: (value: string) => void;
    stderr?: (value: string) => void;
    stdinIsTTY?: boolean;
    readStdin?: () => Promise<string>;
  },
): Promise<number>;
