#!/usr/bin/env node

/**
 * WorkBuddy `Stop` hook → local outbox.
 *
 * Contract with WorkBuddy:
 *   - stdin is hook JSON: { hook_event_name, session_id, transcript_path, cwd }
 *   - only `Stop` is handled. On `UserPromptSubmit` the assistant has not replied
 *     yet, so there is no reply to ship (downstream injection is a later phase).
 *   - stdout stays empty; diagnostics go to stderr only.
 *   - the process ALWAYS exits 0. A failing hook must never block WorkBuddy.
 *   - no network here: the event is queued and the scheduled `flush` sends it.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { realpathSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { deriveEventId } from "./workbuddy-event-id.mjs";
import {
  buildTurnEvent,
  parseTranscriptTail,
  readSessionCwd,
  readSessionTitle,
} from "./workbuddy-transcript.mjs";

/** Initial fast-path content window; retry only when it has no complete turn. */
export const MAX_TAIL_BYTES = 256 * 1024;
export const TAIL_RETRY_BYTES = [MAX_TAIL_BYTES, 1 * 1024 * 1024, 4 * 1024 * 1024];

/** Absolute Stop-hook budget, deliberately well inside installer registration timeout. */
export const HOOK_TOTAL_BUDGET_MS = 4_000;
/** Never wait indefinitely for a WorkBuddy hook writer to close stdin. */
export const STDIN_TIMEOUT_MS = 500;
/** Avoid unbounded stdin buffering before the JSON validation path. */
export const MAX_STDIN_BYTES = 256 * 1024;
/** Give the local enqueue this long, then stop waiting (still exit 0). */
export const ENQUEUE_TIMEOUT_MS = 2_000;

const HANDLED_EVENT = "Stop";

function defaultConnectorPath() {
  return fileURLToPath(new URL("./workbuddy-sync.mjs", import.meta.url));
}

async function readTranscriptTail(fs, path, maxBytes) {
  const handle = await fs.open(path, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("transcript is not a regular file");
    const length = Math.min(Number(stats.size), maxBytes);
    if (length <= 0) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    const position = Math.max(0, Number(stats.size) - length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function remainingMs(deadlineMs) {
  return Math.max(0, deadlineMs - Date.now());
}

function deadlineError(reason) {
  const error = new Error(reason);
  error.code = reason;
  return error;
}

/** Race local filesystem work against the hook-wide deadline without leaking errors. */
function withinDeadline(operation, deadlineMs, reason) {
  const timeoutMs = remainingMs(deadlineMs);
  if (timeoutMs <= 0) return Promise.reject(deadlineError(reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(deadlineError(reason)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function readLatestCompleteTurn(fs, path, deadlineMs, log) {
  let parsed = null;
  for (let index = 0; index < TAIL_RETRY_BYTES.length; index += 1) {
    const maxBytes = TAIL_RETRY_BYTES[index];
    const tail = await withinDeadline(
      readTranscriptTail(fs, path, maxBytes),
      deadlineMs,
      "TRANSCRIPT_READ_TIMEOUT",
    );
    parsed = parseTranscriptTail(tail);
    const turn = parsed.turns.at(-1);
    if (turn) return { parsed, turn };
    const nextBytes = TAIL_RETRY_BYTES[index + 1];
    if (nextBytes) {
      log(`workbuddy-hook: no complete turn in ${maxBytes} byte tail; retrying ${nextBytes}`);
    }
  }
  return { parsed: parsed ?? parseTranscriptTail(""), turn: null };
}

function waitForChild(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      try {
        child.kill?.("SIGKILL");
      } catch {
        /* the child may already be gone */
      }
      finish({ ok: false, reason: "ENQUEUE_TIMEOUT" });
    }, timeoutMs);
    if (typeof timer?.unref === "function") timer.unref();
    child.once?.("error", (error) =>
      finish({ ok: false, reason: `SPAWN_FAILED: ${error?.message}` }),
    );
    child.once?.("exit", (code) =>
      finish(code === 0 ? { ok: true } : { ok: false, reason: `ENQUEUE_EXIT_${code}` }),
    );
  });
}

/**
 * Pure-ish hook body. Every dependency is injectable so tests drive the real
 * parsing/derivation/assembly logic instead of a stand-in.
 *
 * @returns {Promise<{exitCode: 0, ok: boolean, reason: string|null, eventId?: string,
 *   event?: object, eventFile?: string, spawned?: {command: string, args: string[], env: object}}>}
 */
export async function runHook({
  stdinText = "",
  env = process.env,
  fs = nodeFs,
  spawn = nodeSpawn,
  log = (message) => process.stderr.write(`${message}\n`),
  execPath = process.execPath,
  temporaryDirectory = tmpdir(),
  timeoutMs = ENQUEUE_TIMEOUT_MS,
  deadlineMs = Date.now() + HOOK_TOTAL_BUDGET_MS,
} = {}) {
  const skip = (reason) => {
    log(`workbuddy-hook: skipped (${reason})`);
    return { exitCode: 0, ok: false, reason };
  };

  try {
    if (typeof stdinText !== "string" || Buffer.byteLength(stdinText, "utf8") > MAX_STDIN_BYTES) {
      return skip("STDIN_TOO_LARGE");
    }
    let payload;
    try {
      payload = JSON.parse(stdinText);
    } catch {
      return skip("INVALID_STDIN_JSON");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return skip("INVALID_STDIN_SHAPE");
    }
    if (payload.hook_event_name !== HANDLED_EVENT) {
      return skip(`UNHANDLED_EVENT:${String(payload.hook_event_name)}`);
    }

    const sessionKey = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
    if (!sessionKey) return skip("MISSING_SESSION_ID");
    const transcriptPath =
      typeof payload.transcript_path === "string" ? payload.transcript_path.trim() : "";
    if (!transcriptPath) return skip("MISSING_TRANSCRIPT_PATH");

    let latest;
    try {
      latest = await readLatestCompleteTurn(fs, transcriptPath, deadlineMs, log);
    } catch (error) {
      return skip(`TRANSCRIPT_UNREADABLE: ${error?.message ?? "unknown"}`);
    }

    const { parsed, turn } = latest;
    if (!turn) return skip("NO_COMPLETE_TURN");

    // `ai-title` lives near the start of the file, outside the tail on any long
    // session. Resolve it from the same bounded head+tail view `import` uses, or
    // the two paths build different payloads for one event_id and the server's
    // 409 handling quarantines one of them.
    const optionalFileValue = async (operation, label) => {
      try {
        return await withinDeadline(operation, deadlineMs, `${label.toUpperCase()}_READ_TIMEOUT`);
      } catch (error) {
        log(`workbuddy-hook: ${label} lookup failed (${error?.message ?? "unknown"})`);
        return null;
      }
    };
    const [sessionTitle, sessionCwd] = await Promise.all([
      optionalFileValue(readSessionTitle(fs, transcriptPath), "title"),
      optionalFileValue(readSessionCwd(fs, transcriptPath), "cwd"),
    ]);

    const eventId = deriveEventId(sessionKey, turn.userMessageId);
    const event = buildTurnEvent({
      turn,
      sourceSessionKey: sessionKey,
      sessionTitle,
      // The Stop payload cwd can be from a later workspace. Stable event payloads
      // use only the transcript's first message cwd (or the constant fallback).
      cwd: sessionCwd,
      eventId,
    });
    if (!event) return skip("TURN_NOT_REPRESENTABLE");

    const eventFile = join(temporaryDirectory, `workbuddy-hook-${eventId}.json`);
    try {
      await withinDeadline(
        fs.writeFile(eventFile, `${JSON.stringify(event)}\n`, { mode: 0o600 }),
        deadlineMs,
        "EVENT_FILE_WRITE_TIMEOUT",
      );
    } catch (error) {
      return skip(`EVENT_FILE_WRITE_FAILED: ${error?.message ?? "unknown"}`);
    }

    const connectorPath = env.WORKBUDDY_CONNECTOR_PATH || defaultConnectorPath();
    const args = [connectorPath, "sync", "--event-file", eventFile, "--no-send"];
    const childEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
    const spawned = { command: execPath, args, env: childEnv };

    let outcome;
    try {
      const childTimeoutMs = Math.min(timeoutMs, remainingMs(deadlineMs));
      if (childTimeoutMs <= 0) return skip("HOOK_BUDGET_EXHAUSTED");
      const child = spawn(execPath, args, {
        env: childEnv,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let childStderr = "";
      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on?.("data", (chunk) => {
        childStderr += chunk;
      });
      outcome = await waitForChild(child, childTimeoutMs);
      if (!outcome.ok && childStderr.trim())
        log(`workbuddy-hook: connector said ${childStderr.trim()}`);
    } catch (error) {
      outcome = { ok: false, reason: `SPAWN_THREW: ${error?.message ?? "unknown"}` };
    }

    if (outcome.ok) {
      // The connector has copied the event into its own durable outbox.
      try {
        await fs.rm(eventFile, { force: true });
      } catch {
        /* best effort; a stray temp file must not fail the hook */
      }
      return { exitCode: 0, ok: true, reason: null, eventId, event, eventFile, spawned };
    }

    log(`workbuddy-hook: enqueue failed (${outcome.reason})`);
    return { exitCode: 0, ok: false, reason: outcome.reason, eventId, event, eventFile, spawned };
  } catch (error) {
    // Absolute backstop: nothing gets to escape and fail the hook.
    return skip(`UNEXPECTED_ERROR: ${error?.message ?? "unknown"}`);
  }
}

/** Read only a small, time-bounded hook payload; never wait for a stuck writer. */
export function readBoundedStdin(
  stream = process.stdin,
  { maxBytes = MAX_STDIN_BYTES, timeoutMs = STDIN_TIMEOUT_MS } = {},
) {
  return new Promise((resolve) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off?.("data", onData);
      stream.off?.("end", onEnd);
      stream.off?.("error", onError);
      try {
        stream.pause?.();
      } catch {
        /* stdin may already be closed */
      }
      resolve(result);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (totalBytes + bytes.length > maxBytes) {
        finish({ stdinText: "", reason: "STDIN_TOO_LARGE" });
        return;
      }
      chunks.push(bytes);
      totalBytes += bytes.length;
    };
    const onEnd = () => finish({ stdinText: Buffer.concat(chunks).toString("utf8"), reason: null });
    const onError = () => finish({ stdinText: "", reason: "STDIN_UNREADABLE" });
    const timer = setTimeout(() => finish({ stdinText: "", reason: "STDIN_TIMEOUT" }), timeoutMs);
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.resume?.();
  });
}

async function main() {
  const deadlineMs = Date.now() + HOOK_TOTAL_BUDGET_MS;
  try {
    const stdinTimeoutMs = Math.min(STDIN_TIMEOUT_MS, remainingMs(deadlineMs));
    if (stdinTimeoutMs <= 0) {
      process.stderr.write("workbuddy-hook: skipped (HOOK_BUDGET_EXHAUSTED)\n");
      process.exit(0);
    }
    const { stdinText, reason } = await readBoundedStdin(process.stdin, {
      timeoutMs: stdinTimeoutMs,
    });
    if (reason) {
      process.stderr.write(`workbuddy-hook: skipped (${reason})\n`);
      process.exit(0);
    }
    await runHook({ stdinText, deadlineMs });
  } catch (error) {
    process.stderr.write(`workbuddy-hook: stdin unreadable (${error?.message ?? "unknown"})\n`);
  }
  process.exit(0);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  await main();
}
