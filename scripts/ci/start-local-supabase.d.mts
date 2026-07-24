export interface SupabaseCommandResult {
  exitCode: number;
  output: string;
  timedOut?: boolean;
}

export interface SupabaseProcess {
  stdout: {
    on(event: "data", listener: (chunk: { toString(): string }) => void): unknown;
  };
  stderr: {
    on(event: "data", listener: (chunk: { toString(): string }) => void): unknown;
  };
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(event: "close", listener: (exitCode: number | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

export interface SupabaseCommandOptions {
  timeoutMs?: number;
  killGraceMs?: number;
  spawnProcess?: (
    command: string,
    args: readonly string[],
    options: {
      env: NodeJS.ProcessEnv;
      stdio: readonly ["ignore", "pipe", "pipe"];
    },
  ) => SupabaseProcess;
}

export interface SupabaseStartDependencies {
  execute: () => Promise<SupabaseCommandResult>;
  cleanup: () => Promise<void>;
  write: (message: string) => void;
}

export interface SupabaseStartResult {
  exitCode: number;
  attempts: number;
}

export function sanitizeSupabaseDiagnostic(raw: unknown): string;
export function isTransientSupabaseStartFailure(raw: unknown): boolean;
export function executeSupabaseCommand(
  args: readonly string[],
  options?: SupabaseCommandOptions,
): Promise<SupabaseCommandResult>;
export function runSupabaseStart(
  dependencies: SupabaseStartDependencies,
): Promise<SupabaseStartResult>;
