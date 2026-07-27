import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ENQUEUE_TIMEOUT_MS, MAX_TAIL_BYTES, runHook } from "../../connectors/workbuddy-hook.mjs";
import { deriveEventId } from "../../connectors/workbuddy-event-id.mjs";

const connectorPath = resolve(process.cwd(), "connectors/workbuddy-sync.mjs");
const hookSource = resolve(process.cwd(), "connectors/workbuddy-hook.mjs");

const SESSION = "839f4f96-ee9b-4971-8f69-ee7ae576e7f2";
const CWD = "/Users/camp/projects/营地工具/workbuddy-copilot";
const EXPECTED_MAX_STDIN_BYTES = 256 * 1024;
const EXPECTED_STDIN_TIMEOUT_MS = 500;

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "workbuddy-hook-test-"));
  cleanup.push(path);
  return path;
}

function userRow(id: string, query: string, timestamp: number): string {
  return JSON.stringify({
    id,
    timestamp,
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `<system-reminder data-role="user-context">\n<user_info>OS Version: darwin</user_info>\n</system-reminder>\n<user_query>${query}</user_query>`,
      },
    ],
    sessionId: SESSION,
    cwd: CWD,
  });
}

function assistantRow(id: string, text: string, timestamp: number): string {
  return JSON.stringify({
    id,
    parentId: "p",
    timestamp,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ providerData: { annotations: [] }, type: "output_text", text }],
    sessionId: SESSION,
    cwd: CWD,
  });
}

function transcript(): string {
  return (
    [
      JSON.stringify({
        timestamp: 1,
        type: "ai-title",
        aiTitle: "Windows 客户端调研",
        sessionId: SESSION,
        cwd: CWD,
      }),
      userRow("u1", "第一个问题", 1_784_975_834_557),
      assistantRow("a1", "第一个回答", 1_784_975_840_000),
      JSON.stringify({
        id: "fr1",
        timestamp: 1_784_975_845_000,
        type: "function_call_result",
        name: "read_file",
        callId: "c1",
        status: "completed",
        output: "AWS_SECRET_ACCESS_KEY=sk-MUST-NOT-LEAVE-THIS-MACHINE",
        sessionId: SESSION,
        cwd: CWD,
      }),
      userRow("u2", "这个项目的最新版是否支持 Windows 客户端？", 1_784_975_912_995),
      assistantRow("a2", "支持，需要先装 Git Bash。", 1_784_975_920_000),
      assistantRow("a3", "另外浮标 UI 用 WebView2。", 1_784_975_930_000),
    ].join("\n") + "\n"
  );
}

function hookPayload(transcriptPath: string, event = "Stop") {
  return JSON.stringify({
    hook_event_name: event,
    session_id: SESSION,
    transcript_path: transcriptPath,
    cwd: CWD,
  });
}

async function runCliWithOpenStdin(
  stdinText: Buffer | string,
): Promise<{ code: number | null; elapsed: number }> {
  const child = nodeSpawn(process.execPath, [hookSource], {
    env: { ...process.env },
    stdio: ["pipe", "ignore", "pipe"],
  });
  const started = Date.now();
  child.stdin.write(stdinText);
  const outcome = await Promise.race([
    once(child, "exit").then(([code]) => ({ code: Number(code), timedOut: false })),
    new Promise<{ code: null; timedOut: true }>((resolve) =>
      setTimeout(() => resolve({ code: null, timedOut: true }), 1_500),
    ),
  ]);
  if (outcome.timedOut) {
    child.kill("SIGKILL");
    await once(child, "exit");
    throw new Error("hook did not exit while its stdin writer remained open");
  }
  return { code: outcome.code, elapsed: Date.now() - started };
}

async function runCliWithClosedStdin(
  stdinText: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; elapsed: number }> {
  const child = nodeSpawn(process.execPath, [hookSource], {
    env,
    stdio: ["pipe", "ignore", "pipe"],
  });
  const started = Date.now();
  child.stdin.end(stdinText);
  const outcome = await Promise.race([
    once(child, "exit").then(([code]) => ({ code: Number(code), timedOut: false })),
    new Promise<{ code: null; timedOut: true }>((resolve) =>
      setTimeout(() => resolve({ code: null, timedOut: true }), 1_500),
    ),
  ]);
  if (outcome.timedOut) {
    child.kill("SIGKILL");
    await once(child, "exit");
    throw new Error("hook did not exit after stdin closed");
  }
  return { code: outcome.code, elapsed: Date.now() - started };
}

/** Records the spawn boundary; the hook's own logic still runs for real. */
function recordingSpawn() {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn = vi.fn((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options.env });
    const child = new EventEmitter() as EventEmitter & { stderr: null; kill: () => void };
    child.stderr = null;
    child.kill = () => undefined;
    setImmediate(() => child.emit("exit", 0));
    return child;
  });
  return { spawn, calls };
}

describe("WorkBuddy Stop hook safety", () => {
  test("bounds stdin waiting when the hook writer never closes the pipe", async () => {
    const result = await runCliWithOpenStdin('{"hook_event_name":"Stop"');

    expect(result.code).toBe(0);
    expect(result.elapsed).toBeLessThanOrEqual(EXPECTED_STDIN_TIMEOUT_MS + 700);
  });

  test("bounds stdin memory when the hook writer exceeds the byte cap", async () => {
    const result = await runCliWithOpenStdin(Buffer.alloc(EXPECTED_MAX_STDIN_BYTES + 1, 0x20));

    expect(result.code).toBe(0);
    expect(result.elapsed).toBeLessThanOrEqual(EXPECTED_STDIN_TIMEOUT_MS + 700);
  });

  test("does not enqueue a complete oversized Stop payload after stdin closes", async () => {
    const directory = await workspace();
    const stateHome = join(directory, "state");
    const transcriptPath = join(directory, `${SESSION}.jsonl`);
    await writeFile(transcriptPath, transcript(), "utf8");
    const payload = JSON.stringify({
      hook_event_name: "Stop",
      session_id: SESSION,
      transcript_path: transcriptPath,
      cwd: CWD,
      ignored_padding: "x".repeat(EXPECTED_MAX_STDIN_BYTES),
    });

    const result = await runCliWithClosedStdin(payload, {
      ...process.env,
      XDG_STATE_HOME: stateHome,
      LOCALAPPDATA: stateHome,
      WORKBUDDY_CONNECTOR_PATH: connectorPath,
    });

    expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(EXPECTED_MAX_STDIN_BYTES);
    expect(result).toMatchObject({ code: 0 });
    await expect(readdir(join(stateHome, "superbrain-copilot", "outbox"))).rejects.toThrow();
  });

  test("keeps the local enqueue budget far below the registered hook timeout", () => {
    expect(ENQUEUE_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });

  test("survives garbage on stdin without producing an event", async () => {
    const { spawn, calls } = recordingSpawn();
    const log = vi.fn();

    for (const stdinText of ["", "not json", "null", "[]", '{"hook_event_name":', "🐛"]) {
      const result = await runHook({ stdinText, spawn, log, env: {} });
      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.event).toBeUndefined();
    }
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalled();
  });

  test("ignores every hook event except Stop", async () => {
    const directory = await workspace();
    const transcriptPath = join(directory, `${SESSION}.jsonl`);
    await writeFile(transcriptPath, transcript(), "utf8");
    const { spawn, calls } = recordingSpawn();

    for (const event of ["UserPromptSubmit", "SessionStart", "PreToolUse", "SubagentStop", ""]) {
      const result = await runHook({
        stdinText: hookPayload(transcriptPath, event),
        spawn,
        log: () => undefined,
        env: {},
      });
      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe(`UNHANDLED_EVENT:${event}`);
    }
    expect(calls).toHaveLength(0);
  });

  test("exits 0 when the transcript cannot be read", async () => {
    const directory = await workspace();
    const { spawn, calls } = recordingSpawn();

    const missing = await runHook({
      stdinText: hookPayload(join(directory, "nope.jsonl")),
      spawn,
      log: () => undefined,
      env: {},
    });
    expect(missing).toMatchObject({ exitCode: 0, ok: false });
    expect(missing.reason).toMatch(/^TRANSCRIPT_UNREADABLE/);

    const asDirectory = await runHook({
      stdinText: hookPayload(directory),
      spawn,
      log: () => undefined,
      env: {},
    });
    expect(asDirectory).toMatchObject({ exitCode: 0, ok: false });
    expect(calls).toHaveLength(0);
  });

  test("exits 0 and queues nothing when there is no complete turn", async () => {
    const directory = await workspace();
    const { spawn, calls } = recordingSpawn();

    const cases: Array<[string, string]> = [
      ["empty.jsonl", ""],
      [
        "tools-only.jsonl",
        `${JSON.stringify({ id: "f", type: "function_call", name: "ls", arguments: "{}" })}\n`,
      ],
      ["unanswered.jsonl", `${userRow("u1", "还没回答", 1)}\n`],
      [
        "unterminated.jsonl",
        `${userRow("u1", "问题", 1)}\n${assistantRow("a1", "回答", 2)}`.slice(0, -30),
      ],
    ];

    for (const [name, body] of cases) {
      const path = join(directory, name);
      await writeFile(path, body, "utf8");
      const result = await runHook({
        stdinText: hookPayload(path),
        spawn,
        log: () => undefined,
        env: {},
      });
      expect(result, name).toMatchObject({ exitCode: 0, ok: false });
      expect(result.event, name).toBeUndefined();
    }
    expect(calls).toHaveLength(0);
  });

  test("has no network call and no stdout write anywhere in its source", async () => {
    const source = await readFile(hookSource, "utf8");

    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/process\.stdout/);
    expect(source).toMatch(/process\.exit\(0\)/);
    expect(source).toMatch(/"--no-send"/);
  });
});

describe("WorkBuddy Stop hook event assembly", () => {
  test("expands the content tail when a large tool result separates the latest user and reply", async () => {
    const directory = await workspace();
    const stateHome = join(directory, "state");
    const transcriptPath = join(directory, `${SESSION}.jsonl`);
    const body =
      [
        JSON.stringify({ type: "ai-title", aiTitle: "超大工具输出", sessionId: SESSION, cwd: CWD }),
        userRow("u-final", "最后的问题", 1_784_975_912_995),
        JSON.stringify({
          id: "tool-result",
          type: "function_call_result",
          output: "x".repeat(MAX_TAIL_BYTES + 2_048),
          sessionId: SESSION,
          cwd: CWD,
        }),
        assistantRow("a-final", "最后的回答", 1_784_975_920_000),
      ].join("\n") + "\n";
    await writeFile(transcriptPath, body, "utf8");

    const result = await runHook({
      stdinText: hookPayload(transcriptPath),
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        LOCALAPPDATA: stateHome,
        WORKBUDDY_CONNECTOR_PATH: connectorPath,
      },
      temporaryDirectory: directory,
      log: () => undefined,
    });

    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(MAX_TAIL_BYTES);
    expect(result).toMatchObject({ exitCode: 0, ok: true });
    expect(result.event).toMatchObject({
      event_id: deriveEventId(SESSION, "u-final"),
      session_title: "超大工具输出",
      prompt: "最后的问题",
      reply: "最后的回答",
    });
  });

  test("uses the transcript's first message cwd rather than the Stop payload cwd", async () => {
    const directory = await workspace();
    const stateHome = join(directory, "state");
    const transcriptPath = join(directory, `${SESSION}.jsonl`);
    const firstCwd = "/old/source-project";
    const body =
      [
        JSON.stringify({
          id: "u1",
          timestamp: 1_784_975_912_995,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<user_query>问题</user_query>" }],
          sessionId: SESSION,
          cwd: firstCwd,
        }),
        assistantRow("a1", "回答", 1_784_975_920_000),
      ].join("\n") + "\n";
    await writeFile(transcriptPath, body, "utf8");
    const result = await runHook({
      stdinText: JSON.stringify({
        hook_event_name: "Stop",
        session_id: SESSION,
        transcript_path: transcriptPath,
        cwd: "/new/stop-project",
      }),
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        LOCALAPPDATA: stateHome,
        WORKBUDDY_CONNECTOR_PATH: connectorPath,
      },
      log: () => undefined,
      temporaryDirectory: directory,
    });

    expect(result).toMatchObject({ exitCode: 0, ok: true });
    expect(result.event?.session_title).toBe("source-project");
  });

  test("uses the deterministic constant fallback when the first message is beyond the cwd head bound", async () => {
    const directory = await workspace();
    const stateHome = join(directory, "state");
    const transcriptPath = join(directory, `${SESSION}.jsonl`);
    const body =
      [
        JSON.stringify({
          id: "very-large-early-tool-result",
          type: "function_call_result",
          output: "x".repeat(1 * 1024 * 1024 + 2_048),
          sessionId: SESSION,
        }),
        JSON.stringify({
          id: "u1",
          timestamp: 1_784_975_912_995,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<user_query>问题</user_query>" }],
          sessionId: SESSION,
          cwd: "/late/should-not-be-adopted",
        }),
        assistantRow("a1", "回答", 1_784_975_920_000),
      ].join("\n") + "\n";
    await writeFile(transcriptPath, body, "utf8");

    const result = await runHook({
      stdinText: JSON.stringify({
        hook_event_name: "Stop",
        session_id: SESSION,
        transcript_path: transcriptPath,
        cwd: "/new/stop-project",
      }),
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        LOCALAPPDATA: stateHome,
        WORKBUDDY_CONNECTOR_PATH: connectorPath,
      },
      log: () => undefined,
      temporaryDirectory: directory,
    });

    expect(result).toMatchObject({ exitCode: 0, ok: true });
    expect(result.event?.session_title).toBe("WorkBuddy 会话");
  });

  test("uses the first transcript title after the session is renamed", async () => {
    const directory = await workspace();
    const stateHome = join(directory, "state");
    const transcriptPath = join(directory, `${SESSION}.jsonl`);
    const body =
      [
        JSON.stringify({ type: "ai-title", aiTitle: "最初标题", sessionId: SESSION, cwd: CWD }),
        userRow("u1", "问题", 1_784_975_912_995),
        assistantRow("a1", "回答", 1_784_975_920_000),
        JSON.stringify({ type: "custom-title", customTitle: "后来重命名", sessionId: SESSION }),
      ].join("\n") + "\n";
    await writeFile(transcriptPath, body, "utf8");
    const result = await runHook({
      stdinText: hookPayload(transcriptPath),
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        LOCALAPPDATA: stateHome,
        WORKBUDDY_CONNECTOR_PATH: connectorPath,
      },
      log: () => undefined,
      temporaryDirectory: directory,
    });

    expect(result).toMatchObject({ exitCode: 0, ok: true });
    expect(result.event?.session_title).toBe("最初标题");
  });

  test("queues the last complete turn through the connector with --no-send", async () => {
    const directory = await workspace();
    const transcriptPath = join(directory, `${SESSION}.jsonl`);
    await writeFile(transcriptPath, transcript(), "utf8");
    const { spawn, calls } = recordingSpawn();

    const result = await runHook({
      stdinText: hookPayload(transcriptPath),
      env: { WORKBUDDY_CONNECTOR_PATH: connectorPath, PATH: "/usr/bin" },
      spawn,
      log: () => undefined,
      execPath: "/Applications/WorkBuddy.app/Contents/MacOS/Electron",
      temporaryDirectory: directory,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);

    // The event content must match the transcript exactly, not merely be non-empty.
    expect(result.event).toEqual({
      event_id: deriveEventId(SESSION, "u2"),
      source: "connector",
      source_session_key: SESSION,
      session_title: "Windows 客户端调研",
      prompt: "这个项目的最新版是否支持 Windows 客户端？",
      reply: "支持，需要先装 Git Bash。\n\n另外浮标 UI 用 WebView2。",
      client_created_at: new Date(1_784_975_912_995).toISOString(),
    });
    expect(JSON.stringify(result.event)).not.toContain("MUST-NOT-LEAVE-THIS-MACHINE");
    expect(JSON.stringify(result.event)).not.toContain("system-reminder");

    // Exactly one child process, launched on the current runtime as node.
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/Applications/WorkBuddy.app/Contents/MacOS/Electron");
    expect(calls[0].args).toEqual([
      connectorPath,
      "sync",
      "--event-file",
      result.eventFile,
      "--no-send",
    ]);
    expect(calls[0].env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(calls[0].env.PATH).toBe("/usr/bin");
  });

  test("reads only the tail of a huge transcript and still finds the last turn", async () => {
    const directory = await workspace();
    const transcriptPath = join(directory, `${SESSION}.jsonl`);
    const filler = `${assistantRow("old", "旧".repeat(2_000), 1)}\n`.repeat(300);
    await writeFile(transcriptPath, filler + transcript(), "utf8");
    const { spawn, calls } = recordingSpawn();

    const result = await runHook({
      stdinText: hookPayload(transcriptPath),
      env: { WORKBUDDY_CONNECTOR_PATH: connectorPath },
      spawn,
      log: () => undefined,
      temporaryDirectory: directory,
    });

    expect(filler.length).toBeGreaterThan(MAX_TAIL_BYTES);
    expect(result.ok).toBe(true);
    expect(result.event?.prompt).toBe("这个项目的最新版是否支持 Windows 客户端？");
    expect(calls).toHaveLength(1);
  });

  test("derives the same event id when the same Stop fires twice", async () => {
    const directory = await workspace();
    const transcriptPath = join(directory, `${SESSION}.jsonl`);
    await writeFile(transcriptPath, transcript(), "utf8");
    const { spawn } = recordingSpawn();
    const options = {
      stdinText: hookPayload(transcriptPath),
      env: { WORKBUDDY_CONNECTOR_PATH: connectorPath },
      spawn,
      log: () => undefined,
      temporaryDirectory: directory,
    };

    const first = await runHook(options);
    const second = await runHook(options);

    expect(first.eventId).toBe(second.eventId);
    expect(first.event).toEqual(second.event);
  });

  test("stays at exit 0 when the connector child fails", async () => {
    const directory = await workspace();
    const transcriptPath = join(directory, `${SESSION}.jsonl`);
    await writeFile(transcriptPath, transcript(), "utf8");
    const log = vi.fn();

    const failing = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { stderr: null; kill: () => void };
      child.stderr = null;
      child.kill = () => undefined;
      setImmediate(() => child.emit("error", new Error("ENOENT")));
      return child;
    });

    const result = await runHook({
      stdinText: hookPayload(transcriptPath),
      env: { WORKBUDDY_CONNECTOR_PATH: connectorPath },
      spawn: failing,
      log,
      temporaryDirectory: directory,
    });

    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/SPAWN_FAILED/);
    expect(log).toHaveBeenCalled();

    const throwing = await runHook({
      stdinText: hookPayload(transcriptPath),
      env: { WORKBUDDY_CONNECTOR_PATH: connectorPath },
      spawn: (() => {
        throw new Error("spawn is unavailable");
      }) as unknown as typeof failing,
      log,
      temporaryDirectory: directory,
    });
    expect(throwing).toMatchObject({ exitCode: 0, ok: false });
  });
});

describe("WorkBuddy Stop hook end to end against the real connector", () => {
  test("lands the event in the real outbox without configuring any credential", async () => {
    const directory = await workspace();
    const stateHome = join(directory, "state");
    const transcriptPath = join(directory, `${SESSION}.jsonl`);
    await writeFile(transcriptPath, transcript(), "utf8");

    const result = await runHook({
      stdinText: hookPayload(transcriptPath),
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        LOCALAPPDATA: stateHome,
        WORKBUDDY_CONNECTOR_PATH: connectorPath,
      },
      temporaryDirectory: directory,
      log: () => undefined,
    });

    expect(result.ok).toBe(true);
    const outbox = join(stateHome, "superbrain-copilot", "outbox");
    const queued = await readdir(outbox);
    expect(queued).toEqual([`${result.eventId}.json`]);
    expect(JSON.parse(await readFile(join(outbox, queued[0]), "utf8"))).toEqual(result.event);

    // No credential exists, so a send was never even attempted: hook is offline.
    await expect(
      readFile(join(stateHome, "superbrain-copilot", "config.json"), "utf8"),
    ).rejects.toThrow();
    // The temporary handoff file is cleaned up once the connector owns the event.
    await expect(readFile(result.eventFile!, "utf8")).rejects.toThrow();
  });

  test("re-running the same Stop keeps exactly one queued event", async () => {
    const directory = await workspace();
    const stateHome = join(directory, "state");
    const transcriptPath = join(directory, `${SESSION}.jsonl`);
    await writeFile(transcriptPath, transcript(), "utf8");
    const options = {
      stdinText: hookPayload(transcriptPath),
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        LOCALAPPDATA: stateHome,
        WORKBUDDY_CONNECTOR_PATH: connectorPath,
      },
      temporaryDirectory: directory,
      log: () => undefined,
    };

    const first = await runHook(options);
    const second = await runHook(options);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const queued = await readdir(join(stateHome, "superbrain-copilot", "outbox"));
    expect(queued).toEqual([`${first.eventId}.json`]);
  });
});
