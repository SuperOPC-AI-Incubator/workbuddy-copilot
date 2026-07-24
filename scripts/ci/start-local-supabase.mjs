import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_CAPTURED_OUTPUT = 512 * 1024;
const MAX_DIAGNOSTIC_LINES = 80;
const START_TIMEOUT_MS = 8 * 60 * 1_000;
const CLEANUP_TIMEOUT_MS = 2 * 60 * 1_000;
const KILL_GRACE_MS = 5_000;

const diagnosticLinePattern =
  /\b(?:error|failed|failure|timeout|timed out|unhealthy|not ready|pull|manifest|registry|rate limit|too many requests|connection|tls|eof|no such host|context deadline|docker|container|health|exited|denied|forbidden|not found)\b/i;

const transientFailurePatterns = [
  /\btoomanyrequests\b/i,
  /\btoo many requests\b/i,
  /\brate limit(?:ed)?\b/i,
  /\btls handshake timeout\b/i,
  /\bi\/o timeout\b/i,
  /\bconnection (?:reset|refused|timed out)\b/i,
  /\bunexpected eof\b/i,
  /\bno such host\b/i,
  /\btemporary failure in name resolution\b/i,
  /\bcontext deadline exceeded\b/i,
  /\bcontainer is not ready:\s*(?:starting|unhealthy)\b/i,
  /\bhealth checks?.*(?:timeout|timed out|failed|unhealthy)\b/i,
  /\btimed out waiting for .*health\b/i,
  /\bsupabase start command timed out\b/i,
];

function retainTail(current, chunk) {
  const next = current + chunk;
  return next.length <= MAX_CAPTURED_OUTPUT ? next : next.slice(next.length - MAX_CAPTURED_OUTPUT);
}

export function sanitizeSupabaseDiagnostic(raw) {
  const lines = String(raw)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .filter((line) => diagnosticLinePattern.test(line))
    .slice(-MAX_DIAGNOSTIC_LINES)
    .map((line) =>
      line
        .replace(/\b(postgres(?:ql)?:\/\/[^:\s/@]+):[^@\s]+@/gi, "$1:[REDACTED]@")
        .replace(/\b(https?:\/\/[^:\s/@]+):[^@\s]+@/gi, "$1:[REDACTED]@")
        .replace(
          /([?&](?:access_token|token|key|apikey|password|secret)=)[^&\s]+/gi,
          "$1[REDACTED]",
        )
        .replace(
          /(["'][^"']*(?:password|passwd|token|secret|api[_-]?key|anon[_-]?key|publishable[_-]?key|service[_-]?role[_-]?key|access[_-]?key(?:[_-]?id)?|authorization)[^"']*["']\s*:\s*["'])[^"']*/gi,
          "$1[REDACTED]",
        )
        .replace(/\b(authorization\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,;]+/gi, "$1[REDACTED]")
        .replace(
          /\b((?:[A-Z][A-Z0-9_]*_)?(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|ANON_KEY|PUBLISHABLE_KEY|SERVICE_ROLE_KEY|ACCESS_KEY_ID|SECRET_ACCESS_KEY)\s*[:=]\s*)[^\s,;]+/g,
          "$1[REDACTED]",
        )
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
        .replace(
          /\b((?:service[_ -]?role|anon|publishable|secret|jwt)(?:[_ -]?(?:key|secret))?\s*[:=]\s*)\S+/gi,
          "$1[REDACTED]",
        )
        .replace(
          /\b((?:password|passwd|token|authorization|api[_ -]?key|secret_key_base)\s*[:=]\s*)\S+/gi,
          "$1[REDACTED]",
        )
        .slice(0, 500),
    );

  return lines.join("\n") || "Supabase start failed without an allowlisted diagnostic line.";
}

export function isTransientSupabaseStartFailure(raw) {
  return transientFailurePatterns.some((pattern) => pattern.test(String(raw)));
}

export async function runSupabaseStart({ execute, cleanup, write }) {
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await execute();
    if (result.exitCode === 0) {
      write(`Supabase local stack started on attempt ${attempt}.\n`);
      return { exitCode: 0, attempts: attempt };
    }

    write(
      `Supabase start attempt ${attempt}/${maxAttempts} failed.\n` +
        `${sanitizeSupabaseDiagnostic(result.output)}\n`,
    );

    const mayRetry = attempt < maxAttempts && isTransientSupabaseStartFailure(result.output);
    if (!mayRetry) return { exitCode: result.exitCode || 1, attempts: attempt };

    write("Transient startup failure detected; cleaning local containers before one retry.\n");
    try {
      await cleanup();
    } catch (error) {
      write(`Supabase cleanup failed; retry cancelled: ${sanitizeSupabaseDiagnostic(error)}\n`);
      return { exitCode: result.exitCode || 1, attempts: attempt };
    }
  }

  return { exitCode: 1, attempts: maxAttempts };
}

export function executeSupabaseCommand(
  args,
  { timeoutMs = START_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS, spawnProcess = spawn } = {},
) {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    let timeoutHandle;
    let forceKillHandle;
    const child = spawnProcess("supabase", args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(forceKillHandle);
      resolve({ exitCode: timedOut ? 1 : (exitCode ?? 1), output, timedOut });
    };

    child.stdout.on("data", (chunk) => {
      output = retainTail(output, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      output = retainTail(output, chunk.toString());
    });
    child.on("error", (error) => {
      output = retainTail(output, String(error));
      finish(1);
    });
    child.on("close", (code) => {
      finish(code ?? 1);
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      output = retainTail(
        output,
        `\nerror: Supabase ${args[0] ?? "command"} command timed out after ${timeoutMs}ms\n`,
      );
      try {
        if (!child.kill("SIGTERM")) {
          finish(1);
          return;
        }
        forceKillHandle = setTimeout(() => {
          try {
            if (!child.kill("SIGKILL")) finish(1);
          } catch (error) {
            output = retainTail(output, String(error));
            finish(1);
          }
        }, killGraceMs);
      } catch (error) {
        output = retainTail(output, String(error));
        finish(1);
      }
    }, timeoutMs);
  });
}

async function main() {
  const version = await executeSupabaseCommand(["--version"], { timeoutMs: 10_000 });
  const safeVersion = version.output.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? "unknown";
  process.stdout.write(`Supabase CLI version: ${safeVersion}\n`);

  const result = await runSupabaseStart({
    execute: () =>
      executeSupabaseCommand(["start"], {
        timeoutMs: START_TIMEOUT_MS,
      }),
    cleanup: async () => {
      const cleanup = await executeSupabaseCommand(["stop", "--no-backup"], {
        timeoutMs: CLEANUP_TIMEOUT_MS,
      });
      if (cleanup.exitCode !== 0) {
        throw new Error(cleanup.output);
      }
    },
    write: (message) => process.stderr.write(message),
  });
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
