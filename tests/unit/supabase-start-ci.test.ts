import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";

import {
  executeSupabaseCommand,
  runSupabaseStart,
  sanitizeSupabaseDiagnostic,
} from "../../scripts/ci/start-local-supabase.mjs";
import type { SupabaseProcess } from "../../scripts/ci/start-local-supabase.mjs";

describe("local Supabase CI startup", () => {
  test("redacts credentials while retaining actionable failure evidence", () => {
    const diagnostic = sanitizeSupabaseDiagnostic(`
failed to pull docker image: TLS handshake timeout
error DB URL: postgresql://postgres:database-secret@127.0.0.1:54322/postgres
error service_role key: eyJhbGciOiJIUzI1NiJ9.secret.signature
error registry request: https://registry.example/pull?access_token=query-secret
error Authorization: Bearer bearer-secret
error registry Authorization: Basic basic-secret
failed SUPABASE_SERVICE_ROLE_KEY=sb_secret_env-secret
docker error: {"access_token":"json-secret"}
docker error: {"service_role_key":"json-role-secret","anon_key":"json-anon-secret"}
unrelated successful progress line
`);

    expect(diagnostic).toContain("failed to pull docker image: TLS handshake timeout");
    expect(diagnostic).toContain("postgres:[REDACTED]@127.0.0.1");
    expect(diagnostic).toContain("service_role key: [REDACTED]");
    expect(diagnostic).not.toContain("database-secret");
    expect(diagnostic).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(diagnostic).not.toContain("query-secret");
    expect(diagnostic).not.toContain("bearer-secret");
    expect(diagnostic).not.toContain("basic-secret");
    expect(diagnostic).not.toContain("env-secret");
    expect(diagnostic).not.toContain("json-secret");
    expect(diagnostic).not.toContain("json-role-secret");
    expect(diagnostic).not.toContain("json-anon-secret");
    expect(diagnostic).not.toContain("unrelated successful progress line");
  });

  test("terminates a hung command before returning a timeout failure", async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn((signal: NodeJS.Signals): boolean => {
        if (signal === "SIGKILL") {
          queueMicrotask(() => child.emit("close", null));
        }
        return true;
      });
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill,
      }) as EventEmitter & SupabaseProcess;

      const resultPromise = executeSupabaseCommand(["start"], {
        timeoutMs: 1_000,
        killGraceMs: 100,
        spawnProcess: vi.fn(() => child),
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      await vi.advanceTimersByTimeAsync(100);

      await expect(resultPromise).resolves.toMatchObject({
        exitCode: 1,
        timedOut: true,
        output: expect.stringContaining("command timed out"),
      });
      expect(kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  test("preserves a successful child-process exit code", async () => {
    const kill = vi.fn((_signal: NodeJS.Signals): boolean => true);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill,
    }) as EventEmitter & SupabaseProcess;

    const resultPromise = executeSupabaseCommand(["start"], {
      timeoutMs: 1_000,
      spawnProcess: vi.fn(() => {
        queueMicrotask(() => child.emit("close", 0));
        return child;
      }),
    });

    await expect(resultPromise).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
    expect(kill).not.toHaveBeenCalled();
  });

  test("keeps a timed-out command failed even if TERM closes with zero", async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn((signal: NodeJS.Signals): boolean => {
        if (signal === "SIGTERM") {
          queueMicrotask(() => child.emit("close", 0));
        }
        return true;
      });
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill,
      }) as EventEmitter & SupabaseProcess;

      const resultPromise = executeSupabaseCommand(["start"], {
        timeoutMs: 1_000,
        killGraceMs: 100,
        spawnProcess: vi.fn(() => child),
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(resultPromise).resolves.toMatchObject({
        exitCode: 1,
        timedOut: true,
      });
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(kill).not.toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  test("cleans up and retries one clear transient startup failure", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 1,
        output: "supabase_storage container is not ready: unhealthy",
      })
      .mockResolvedValueOnce({ exitCode: 0, output: "credentials must stay hidden" });
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn();

    const result = await runSupabaseStart({ execute, cleanup, write });

    expect(result).toEqual({ exitCode: 0, attempts: 2 });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("container is not ready: unhealthy"),
    );
    expect(write).not.toHaveBeenCalledWith(expect.stringContaining("credentials must stay hidden"));
  });

  test("does not retry a deterministic configuration failure", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 1,
      output: "failed to parse config: invalid port",
    });
    const cleanup = vi.fn();

    const result = await runSupabaseStart({ execute, cleanup, write: vi.fn() });

    expect(result).toEqual({ exitCode: 1, attempts: 1 });
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("does not retry a permanently missing image", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 1,
      output: "failed to pull docker image: manifest unknown",
    });
    const cleanup = vi.fn();

    const result = await runSupabaseStart({ execute, cleanup, write: vi.fn() });

    expect(result).toEqual({ exitCode: 1, attempts: 1 });
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("keeps CI red when the bounded retry also fails", async () => {
    const execute = vi.fn().mockResolvedValue({
      exitCode: 1,
      output: "failed to pull docker image: connection reset by peer",
    });
    const cleanup = vi.fn().mockResolvedValue(undefined);

    const result = await runSupabaseStart({ execute, cleanup, write: vi.fn() });

    expect(result).toEqual({ exitCode: 1, attempts: 2 });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
