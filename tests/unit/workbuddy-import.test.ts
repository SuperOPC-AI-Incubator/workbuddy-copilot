import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createWorkbuddyConnector,
  runCli,
  type WorkbuddyConnector,
} from "../../connectors/workbuddy-sync.mjs";
import { deriveEventId } from "../../connectors/workbuddy-event-id.mjs";
import { runHook } from "../../connectors/workbuddy-hook.mjs";

const connectorPath = resolve(process.cwd(), "connectors/workbuddy-sync.mjs");
const TOKEN = "wb_import_secret_that_must_never_leak";
const INGEST_SESSION = "30000000-0000-4000-8000-000000000001";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "workbuddy-import-test-"));
  cleanup.push(path);
  return path;
}

function userRow(id: string, query: string, timestamp: number, sessionId: string, cwd: string) {
  return JSON.stringify({
    id,
    timestamp,
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: `<system-reminder data-role="user-context">OS: darwin</system-reminder>\n<user_query>${query}</user_query>`,
      },
    ],
    sessionId,
    cwd,
  });
}

function assistantRow(id: string, text: string, timestamp: number, sessionId: string, cwd: string) {
  return JSON.stringify({
    id,
    timestamp,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
    sessionId,
    cwd,
  });
}

type Round = { userId: string; prompt: string; assistantId: string; reply: string };

function sessionBody(sessionId: string, cwd: string, title: string, rounds: Round[]): string {
  const rows = [JSON.stringify({ timestamp: 1, type: "ai-title", aiTitle: title, sessionId, cwd })];
  let clock = 1_784_900_000_000;
  for (const round of rounds) {
    rows.push(userRow(round.userId, round.prompt, (clock += 1_000), sessionId, cwd));
    rows.push(assistantRow(round.assistantId, round.reply, (clock += 1_000), sessionId, cwd));
  }
  return `${rows.join("\n")}\n`;
}

async function writeSession(
  projectsDir: string,
  project: string,
  sessionId: string,
  body: string,
  ageMs = 0,
): Promise<string> {
  const directory = join(projectsDir, project);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${sessionId}.jsonl`);
  await writeFile(path, body, "utf8");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await utimes(path, when, when);
  }
  return path;
}

function ingestResponse(eventId: string) {
  return Response.json({
    ok: true,
    event_id: eventId,
    session_id: INGEST_SESSION,
    item_ids: { prompt: crypto.randomUUID(), reply: crypto.randomUUID(), diagnosis: null },
    duplicate: false,
  });
}

type Sent = { url: string; body: Record<string, unknown> };

async function configuredConnector(
  stateDir: string,
): Promise<{ connector: WorkbuddyConnector; sent: Sent[]; fetchImpl: ReturnType<typeof vi.fn> }> {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ url: String(url), body });
    return ingestResponse(String(body.event_id));
  });
  const connector = createWorkbuddyConnector({
    stateDir,
    apiUrl: "https://copilot.example.test",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async () => undefined,
    jitter: () => 0,
  });
  await connector.configure({ apiUrl: connector.apiUrl!, token: TOKEN });
  return { connector, sent, fetchImpl };
}

async function runImport(
  connector: WorkbuddyConnector,
  args: string[],
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["import", ...args], {
    connector,
    stdout: (value) => out.push(value),
    stderr: (value) => err.push(value),
  });
  return { code, out, err };
}

const DAY = 24 * 60 * 60 * 1_000;

describe("workbuddy-sync import window", () => {
  test("filters each selected session's turns to the hard time window and reports the real dry-run count", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const session = "a0000000-0000-4000-8000-000000000010";
    const now = Date.now();
    await writeSession(
      projectsDir,
      "mixed-age",
      session,
      [
        JSON.stringify({ type: "ai-title", aiTitle: "混合会话", sessionId: session }),
        userRow("u-old", "八天前的问题", now - 8 * DAY, session, "/w/mixed-age"),
        assistantRow("a-old", "八天前的回答", now - 8 * DAY + 1_000, session, "/w/mixed-age"),
        userRow("u-new", "两小时前的问题", now - 2 * 60 * 60 * 1_000, session, "/w/mixed-age"),
        assistantRow(
          "a-new",
          "两小时前的回答",
          now - 2 * 60 * 60 * 1_000 + 1_000,
          session,
          "/w/mixed-age",
        ),
        "",
      ].join("\n"),
    );

    const { connector, sent } = await configuredConnector(join(directory, "state"));
    const dryRun = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--dry-run",
      "--throttle-ms",
      "0",
    ]);

    expect(dryRun.code).toBe(0);
    expect(JSON.parse(dryRun.out[0])).toMatchObject({
      eligibleSessions: 1,
      sessionsWithTurns: 1,
      turns: 1,
      excludedTurns: 1,
    });
    expect(dryRun.err.join("\n")).toContain("excluded_turns=1");
    expect(sent).toEqual([]);

    const sentRun = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--throttle-ms",
      "0",
    ]);
    expect(sentRun.code).toBe(0);
    expect(sent.map((entry) => entry.body.prompt)).toEqual(["两小时前的问题"]);
    expect(JSON.stringify(sent)).not.toContain("八天前的问题");
  });

  test("safely excludes turns without a usable user timestamp and logs the decision", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const session = "a0000000-0000-4000-8000-000000000011";
    const now = Date.now();
    await writeSession(
      projectsDir,
      "missing-time",
      session,
      [
        JSON.stringify({ type: "ai-title", aiTitle: "缺失时间", sessionId: session }),
        JSON.stringify({
          id: "u-missing",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<user_query>没有时间的问题</user_query>" }],
          sessionId: session,
          cwd: "/w/missing-time",
        }),
        assistantRow("a-missing", "没有时间的回答", now - 1_000, session, "/w/missing-time"),
        userRow("u-new", "有时间的问题", now - 1_000, session, "/w/missing-time"),
        assistantRow("a-new", "有时间的回答", now, session, "/w/missing-time"),
        "",
      ].join("\n"),
    );
    const { connector, sent } = await configuredConnector(join(directory, "state"));

    const result = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--throttle-ms",
      "0",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0])).toMatchObject({ turns: 1, missingTimestampTurns: 1 });
    expect(result.err.join("\n")).toContain("missing_timestamp_turns=1");
    expect(sent.map((entry) => entry.body.prompt)).toEqual(["有时间的问题"]);
  });

  test("skips timestamps outside Date's range without aborting later sessions", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const invalid = "a0000000-0000-4000-8000-000000000012";
    const valid = "a0000000-0000-4000-8000-000000000013";
    await writeSession(
      projectsDir,
      "invalid",
      invalid,
      [
        JSON.stringify({ type: "ai-title", aiTitle: "异常时间", sessionId: invalid }),
        userRow("u-invalid", "不能让导入崩溃", 8_640_000_000_000_001, invalid, "/w/invalid"),
        assistantRow("a-invalid", "无效时间回答", Date.now(), invalid, "/w/invalid"),
        "",
      ].join("\n"),
    );
    await writeSession(
      projectsDir,
      "valid",
      valid,
      sessionBody(valid, "/w/valid", "仍应继续", [
        { userId: "u-valid", prompt: "后续会话", assistantId: "a-valid", reply: "后续回答" },
      ]),
    );
    const { connector, sent } = await configuredConnector(join(directory, "state"));

    const result = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--throttle-ms",
      "0",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0])).toMatchObject({
      invalidTimestampTurns: 1,
      turns: 1,
      sent: 1,
    });
    expect(result.err.join("\n")).toContain("invalid_timestamp_turns=1");
    expect(sent.map((entry) => entry.body.prompt)).toEqual(["后续会话"]);
  });

  test("refuses any window wider than 7 days", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    await writeSession(
      projectsDir,
      "proj",
      "a0000000-0000-4000-8000-000000000001",
      sessionBody("a0000000-0000-4000-8000-000000000001", "/w/proj", "标题", [
        { userId: "u1", prompt: "问题", assistantId: "a1", reply: "回答" },
      ]),
    );
    const { connector, sent } = await configuredConnector(join(directory, "state"));

    for (const since of ["8d", "30d", "365d", "169h"]) {
      const result = await runImport(connector, ["--projects-dir", projectsDir, "--since", since]);
      expect(result.code, since).toBe(2);
      expect(result.err.join("\n"), since).toContain("SINCE_WINDOW_TOO_LARGE");
    }
    expect(sent).toHaveLength(0);
    expect(await readdir(join(directory, "state", "outbox"))).toEqual([]);
  });

  test("rejects malformed windows and accepts narrowing ones", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    await writeSession(
      projectsDir,
      "proj",
      "a0000000-0000-4000-8000-000000000002",
      sessionBody("a0000000-0000-4000-8000-000000000002", "/w/proj", "标题", [
        { userId: "u1", prompt: "问题", assistantId: "a1", reply: "回答" },
      ]),
    );
    const { connector } = await configuredConnector(join(directory, "state"));

    for (const since of ["forever", "7", "d", "-1d", "1w", "7 d"]) {
      const bad = await runImport(connector, ["--projects-dir", projectsDir, "--since", since]);
      expect(bad.code, since).toBe(2);
      expect(bad.err.join("\n"), since).toMatch(/INVALID_ARGUMENTS|SINCE_WINDOW_TOO_LARGE/);
    }

    const narrowed = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--since",
      "3d",
      "--throttle-ms",
      "0",
      "--dry-run",
    ]);
    expect(narrowed.code).toBe(0);
    expect(JSON.parse(narrowed.out[0])).toMatchObject({ window: "3d", eligibleSessions: 1 });
  });

  test("excludes sessions older than the window and reports how many", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const fresh = "b0000000-0000-4000-8000-000000000001";
    const stale = "b0000000-0000-4000-8000-000000000002";
    const staleAlso = "b0000000-0000-4000-8000-000000000003";
    await writeSession(
      projectsDir,
      "recent",
      fresh,
      sessionBody(fresh, "/w/recent", "新的", [
        { userId: "u1", prompt: "新问题", assistantId: "a1", reply: "新回答" },
      ]),
    );
    await writeSession(
      projectsDir,
      "old",
      stale,
      sessionBody(stale, "/w/old", "旧的", [
        { userId: "u9", prompt: "旧问题", assistantId: "a9", reply: "旧回答" },
      ]),
      8 * DAY,
    );
    await writeSession(
      projectsDir,
      "old",
      staleAlso,
      sessionBody(staleAlso, "/w/old", "更旧的", [
        { userId: "u8", prompt: "更旧问题", assistantId: "a8", reply: "更旧回答" },
      ]),
      40 * DAY,
    );

    const { connector, sent } = await configuredConnector(join(directory, "state"));
    const result = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--throttle-ms",
      "0",
    ]);

    expect(result.code).toBe(0);
    const summary = JSON.parse(result.out[0]);
    expect(summary).toMatchObject({
      scannedSessions: 3,
      eligibleSessions: 1,
      excludedSessions: 2,
      turns: 1,
      sent: 1,
    });
    // The count must be logged, not silently swallowed.
    expect(result.err.join("\n")).toContain("excluded_sessions=2");

    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatchObject({ prompt: "新问题", source_session_key: fresh });
    expect(JSON.stringify(sent)).not.toContain("旧问题");
    expect(JSON.stringify(sent)).not.toContain("更旧问题");
  });
});

describe("workbuddy-sync import behaviour", () => {
  test("dry run reports the plan and writes nothing at all", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const stateDir = join(directory, "state");
    const one = "c0000000-0000-4000-8000-000000000001";
    const two = "c0000000-0000-4000-8000-000000000002";
    await writeSession(
      projectsDir,
      "p1",
      one,
      sessionBody(one, "/w/p1", "会话一", [
        { userId: "u1", prompt: "问题一", assistantId: "a1", reply: "回答一" },
        { userId: "u2", prompt: "问题二", assistantId: "a2", reply: "回答二" },
      ]),
    );
    await writeSession(
      projectsDir,
      "p2",
      two,
      sessionBody(two, "/w/p2", "会话二", [
        { userId: "u3", prompt: "问题三", assistantId: "a3", reply: "回答三" },
      ]),
    );

    const { connector, sent } = await configuredConnector(stateDir);
    const result = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--dry-run",
      "--throttle-ms",
      "0",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0])).toMatchObject({
      dryRun: true,
      eligibleSessions: 2,
      sessionsWithTurns: 2,
      turns: 3,
      queued: 0,
      sent: 0,
    });
    expect(sent).toHaveLength(0);
    expect(await readdir(join(stateDir, "outbox"))).toEqual([]);
    expect(await readdir(join(stateDir, "claims"))).toEqual([]);
    expect(await readdir(join(stateDir, "quarantine"))).toEqual([]);
  });

  test("sends every turn in order, oldest session first, and drains the outbox", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const stateDir = join(directory, "state");
    const older = "d0000000-0000-4000-8000-000000000001";
    const newer = "d0000000-0000-4000-8000-000000000002";
    await writeSession(
      projectsDir,
      "p1",
      older,
      sessionBody(older, "/w/p1", "较早的会话", [
        { userId: "u1", prompt: "问题一", assistantId: "a1", reply: "回答一" },
        { userId: "u2", prompt: "问题二", assistantId: "a2", reply: "回答二" },
      ]),
      2 * DAY,
    );
    await writeSession(
      projectsDir,
      "p2",
      newer,
      sessionBody(newer, "/w/p2", "较晚的会话", [
        { userId: "u3", prompt: "问题三", assistantId: "a3", reply: "回答三" },
      ]),
    );

    const { connector, sent } = await configuredConnector(stateDir);
    const result = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--throttle-ms",
      "0",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0])).toMatchObject({ turns: 3, queued: 3, sent: 3 });

    expect(sent.map((entry) => entry.body.prompt)).toEqual(["问题一", "问题二", "问题三"]);
    expect(sent.map((entry) => entry.body.source_session_key)).toEqual([older, older, newer]);
    expect(sent[0].body).toMatchObject({
      event_id: deriveEventId(older, "u1"),
      source: "connector",
      session_title: "较早的会话",
      reply: "回答一",
    });
    expect(sent[2].body).toMatchObject({
      event_id: deriveEventId(newer, "u3"),
      session_title: "较晚的会话",
    });
    for (const entry of sent) expect(entry.url).toContain("/api/public/workbuddy/ingest");

    expect(await readdir(join(stateDir, "outbox"))).toEqual([]);
    expect(await readdir(join(stateDir, "claims"))).toEqual([]);
  });

  test("re-running produces the same event ids so the server sees duplicates", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const stateDir = join(directory, "state");
    const session = "e0000000-0000-4000-8000-000000000001";
    await writeSession(
      projectsDir,
      "p1",
      session,
      sessionBody(session, "/w/p1", "会话", [
        { userId: "u1", prompt: "问题一", assistantId: "a1", reply: "回答一" },
      ]),
    );

    const { connector, sent } = await configuredConnector(stateDir);
    await runImport(connector, ["--projects-dir", projectsDir, "--throttle-ms", "0"]);
    await runImport(connector, ["--projects-dir", projectsDir, "--throttle-ms", "0"]);

    expect(sent).toHaveLength(2);
    expect(sent[0].body.event_id).toBe(sent[1].body.event_id);
    expect(sent[0].body).toEqual(sent[1].body);
  });

  test("truncates an oversized turn instead of dropping it", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const session = "f0000000-0000-4000-8000-000000000001";
    await writeSession(
      projectsDir,
      "p1",
      session,
      sessionBody(session, "/w/p1", "长会话", [
        { userId: "u1", prompt: "问".repeat(9_000), assistantId: "a1", reply: "答".repeat(30_000) },
        { userId: "u2", prompt: "短问题", assistantId: "a2", reply: "短回答" },
      ]),
    );

    const { connector, sent } = await configuredConnector(join(directory, "state"));
    const result = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--throttle-ms",
      "0",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0])).toMatchObject({ turns: 2, sent: 2, truncatedTurns: 1 });
    expect(result.err.join("\n")).toContain("truncated_turns=1");

    expect(sent).toHaveLength(2);
    expect(String(sent[0].body.prompt).length).toBe(4_000);
    expect(String(sent[0].body.reply).length).toBe(8_000);
    expect(String(sent[0].body.prompt)).toContain("[…内容超出上限已截断]");
    expect(String(sent[0].body.reply)).toContain("[…内容超出上限已截断]");
    expect(sent[1].body.prompt).toBe("短问题");
  });

  test("fails loudly when the projects directory does not exist", async () => {
    const directory = await workspace();
    const { connector } = await configuredConnector(join(directory, "state"));

    const result = await runImport(connector, ["--projects-dir", join(directory, "nope")]);

    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("PROJECTS_DIR_MISSING");
  });

  test("uses WORKBUDDY_HOME for the default import location", async () => {
    const directory = await workspace();
    const workbuddyHome = join(directory, "custom-workbuddy-home");
    const session = "f0000000-0000-4000-8000-000000000002";
    await writeSession(
      join(workbuddyHome, "projects"),
      "custom-project",
      session,
      sessionBody(session, "/w/custom-project", "自定义根目录", [
        { userId: "u1", prompt: "来自覆盖目录", assistantId: "a1", reply: "已找到" },
      ]),
    );
    const previousWorkbuddyHome = process.env.WORKBUDDY_HOME;
    const previousHome = process.env.HOME;
    process.env.WORKBUDDY_HOME = workbuddyHome;
    // Under the unfixed implementation the fallback must point at a disposable
    // directory; a RED test must never scan a developer's real transcript root.
    process.env.HOME = directory;
    try {
      const { connector, sent } = await configuredConnector(join(directory, "state"));
      const result = await runImport(connector, ["--throttle-ms", "0"]);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.out[0])).toMatchObject({
        projectsDir: join(workbuddyHome, "projects"),
        turns: 1,
        sent: 1,
      });
      expect(sent.map((entry) => entry.body.prompt)).toEqual(["来自覆盖目录"]);
    } finally {
      if (previousWorkbuddyHome === undefined) delete process.env.WORKBUDDY_HOME;
      else process.env.WORKBUDDY_HOME = previousWorkbuddyHome;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  test("counts and identifies every session truncated to the 8 MiB tail even at a newline boundary", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const session = "f0000000-0000-4000-8000-000000000003";
    const now = Date.now();
    const oldRound = [
      userRow("u-lost", "必须被标为可能漏掉的前部轮次", now - 1_000, session, "/w/large"),
      assistantRow("a-lost", "旧回答", now, session, "/w/large"),
    ].join("\n");
    const tailEnd = [
      userRow("u-tail", "尾部仍可读取的问题", now - 1_000, session, "/w/large"),
      assistantRow("a-tail", "尾部仍可读取的回答", now, session, "/w/large"),
      "",
    ].join("\n");
    const largeRowPrefix = '{"type":"function_call_result","output":"';
    const largeRowSuffix = '"}\n';
    const maximumTailBytes = 8 * 1_024 * 1_024;
    const fillerLength =
      maximumTailBytes -
      Buffer.byteLength(largeRowPrefix) -
      Buffer.byteLength(largeRowSuffix) -
      Buffer.byteLength(tailEnd);
    const exactTail = `${largeRowPrefix}${"x".repeat(fillerLength)}${largeRowSuffix}${tailEnd}`;
    expect(Buffer.byteLength(exactTail)).toBe(maximumTailBytes);
    await writeSession(projectsDir, "large", session, `${oldRound}\n${exactTail}`);

    const { connector, sent } = await configuredConnector(join(directory, "state"));
    const result = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--throttle-ms",
      "0",
    ]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out[0])).toMatchObject({
      partialSessions: 1,
      truncatedSessions: 1,
      omittedBytes: Buffer.byteLength(`${oldRound}\n`),
      turns: 1,
      sent: 1,
    });
    expect(result.err.join("\n")).toContain(`session ${session} truncated`);
    expect(sent.map((entry) => entry.body.prompt)).toEqual(["尾部仍可读取的问题"]);
    expect(JSON.stringify(sent)).not.toContain("必须被标为可能漏掉的前部轮次");
  });
});

describe("import and the Stop hook agree on identity", () => {
  test("a rename after live sync cannot change import's payload for the same event id", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const session = "099f9849-1385-4b4b-9eb3-8edca841b115";
    const transcriptPath = await writeSession(
      projectsDir,
      "renamed",
      session,
      sessionBody(session, "/Users/camp/WorkBuddy/renamed", "最初标题", [
        { userId: "u1", prompt: "重命名前的问题", assistantId: "a1", reply: "重命名前的回答" },
      ]),
    );
    const hookState = join(directory, "hook-state");
    const hookResult = await runHook({
      stdinText: JSON.stringify({
        hook_event_name: "Stop",
        session_id: session,
        transcript_path: transcriptPath,
        cwd: "/Users/camp/WorkBuddy/renamed",
      }),
      env: {
        ...process.env,
        XDG_STATE_HOME: hookState,
        LOCALAPPDATA: hookState,
        WORKBUDDY_CONNECTOR_PATH: connectorPath,
      },
      temporaryDirectory: directory,
      log: () => undefined,
    });
    expect(hookResult.ok).toBe(true);
    await appendFile(
      transcriptPath,
      `${JSON.stringify({ type: "custom-title", customTitle: "后来重命名", sessionId: session })}\n`,
      "utf8",
    );

    const { connector, sent } = await configuredConnector(join(directory, "import-state"));
    const result = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--throttle-ms",
      "0",
    ]);

    expect(result.code).toBe(0);
    const imported = sent.find((entry) => entry.body.event_id === hookResult.eventId)?.body;
    expect(imported).toEqual(hookResult.event);
    expect(imported).toMatchObject({ session_title: "最初标题" });
  });

  test("a titleless import uses the transcript's first message cwd, never Stop stdin cwd", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const session = "099f9849-1385-4b4b-9eb3-8edca841b116";
    const transcriptPath = await writeSession(
      projectsDir,
      "cwd",
      session,
      [
        userRow(
          "u1",
          "以文件 cwd 为准",
          Date.now() - 1_000,
          session,
          "/Users/camp/original-project",
        ),
        assistantRow("a1", "必须同源", Date.now(), session, "/Users/camp/original-project"),
        "",
      ].join("\n"),
    );
    const hookState = join(directory, "hook-state");
    const hookResult = await runHook({
      stdinText: JSON.stringify({
        hook_event_name: "Stop",
        session_id: session,
        transcript_path: transcriptPath,
        cwd: "/Users/camp/recent-but-wrong",
      }),
      env: {
        ...process.env,
        XDG_STATE_HOME: hookState,
        LOCALAPPDATA: hookState,
        WORKBUDDY_CONNECTOR_PATH: connectorPath,
      },
      temporaryDirectory: directory,
      log: () => undefined,
    });
    expect(hookResult.ok).toBe(true);

    const { connector, sent } = await configuredConnector(join(directory, "import-state"));
    const result = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--throttle-ms",
      "0",
    ]);
    const imported = sent.find((entry) => entry.body.event_id === hookResult.eventId)?.body;

    expect(result.code).toBe(0);
    expect(imported).toEqual(hookResult.event);
    expect(imported).toMatchObject({ session_title: "original-project" });
    expect(imported).not.toMatchObject({ session_title: "recent-but-wrong" });
  });

  test("the same round gets one event id from either path", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const session = "099f9849-1385-4b4b-9eb3-8edca841b114";
    const body = sessionBody(session, "/Users/camp/WorkBuddy/demo", "共同会话", [
      { userId: "u1", prompt: "第一个问题", assistantId: "a1", reply: "第一个回答" },
      { userId: "u2", prompt: "第二个问题", assistantId: "a2", reply: "第二个回答" },
    ]);
    const transcriptPath = await writeSession(projectsDir, "demo", session, body);

    // Path 1: the live Stop hook queues the last round into its own state dir.
    const hookState = join(directory, "hook-state");
    const hookResult = await runHook({
      stdinText: JSON.stringify({
        hook_event_name: "Stop",
        session_id: session,
        transcript_path: transcriptPath,
        cwd: "/Users/camp/WorkBuddy/demo",
      }),
      env: {
        ...process.env,
        XDG_STATE_HOME: hookState,
        LOCALAPPDATA: hookState,
        WORKBUDDY_CONNECTOR_PATH: connectorPath,
      },
      temporaryDirectory: directory,
      log: () => undefined,
    });
    expect(hookResult.ok).toBe(true);

    // Path 2: backfill walks the same file from disk.
    const { connector, sent } = await configuredConnector(join(directory, "import-state"));
    const result = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--throttle-ms",
      "0",
    ]);
    expect(result.code).toBe(0);

    const importedLast = sent.at(-1)!.body;
    expect(importedLast.event_id).toBe(hookResult.eventId);
    expect(importedLast.event_id).toBe(deriveEventId(session, "u2"));
    // Identical payloads mean the server's idempotency check sees a true duplicate.
    expect(importedLast).toEqual(hookResult.event);

    const hookQueued = await readdir(join(hookState, "superbrain-copilot", "outbox"));
    expect(hookQueued).toEqual([`${hookResult.eventId}.json`]);
    expect(
      JSON.parse(
        await readFile(join(hookState, "superbrain-copilot", "outbox", hookQueued[0]), "utf8"),
      ),
    ).toEqual(importedLast);
  });

  test("agree on a long session whose title sits far outside the hook's tail", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const session = "0a1b2c3d-1385-4b4b-9eb3-8edca841b114";
    const cwd = "/Users/camp/WorkBuddy/long";

    // ai-title first (as WorkBuddy writes it), then >256 KiB of tool traffic, then
    // the real last round. The hook's 256 KiB tail cannot see the title row.
    const head = [
      JSON.stringify({
        timestamp: 1,
        type: "ai-title",
        aiTitle: "只在文件头出现的标题",
        sessionId: session,
        cwd,
      }),
      userRow("u1", "第一个问题", 1_784_900_001_000, session, cwd),
      assistantRow("a1", "第一个回答", 1_784_900_002_000, session, cwd),
    ].join("\n");
    const fillerRow = JSON.stringify({
      id: "fc",
      timestamp: 1_784_900_003_000,
      type: "function_call_result",
      name: "read_file",
      callId: "c",
      status: "completed",
      output: "填".repeat(4_000),
      sessionId: session,
      cwd,
    });
    const filler = Array.from({ length: 40 }, () => fillerRow).join("\n");
    const tail = [
      userRow("u9", "最后一个问题", 1_784_900_009_000, session, cwd),
      assistantRow("a9", "最后一个回答", 1_784_900_010_000, session, cwd),
    ].join("\n");
    const body = `${head}\n${filler}\n${tail}\n`;

    const transcriptPath = await writeSession(projectsDir, "long", session, body);
    const bytes = Buffer.byteLength(body, "utf8");
    const titleOffset = Buffer.byteLength(head.split("\n")[0], "utf8");
    // The title really is unreachable from a 256 KiB tail read.
    expect(bytes).toBeGreaterThan(256 * 1024);
    expect(bytes - titleOffset).toBeGreaterThan(256 * 1024);

    const hookState = join(directory, "hook-state");
    const hookResult = await runHook({
      stdinText: JSON.stringify({
        hook_event_name: "Stop",
        session_id: session,
        transcript_path: transcriptPath,
        cwd,
      }),
      env: {
        ...process.env,
        XDG_STATE_HOME: hookState,
        LOCALAPPDATA: hookState,
        WORKBUDDY_CONNECTOR_PATH: connectorPath,
      },
      temporaryDirectory: directory,
      log: () => undefined,
    });
    expect(hookResult.ok).toBe(true);

    const { connector, sent } = await configuredConnector(join(directory, "import-state"));
    const result = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--throttle-ms",
      "0",
    ]);
    expect(result.code).toBe(0);

    const twin = sent.find((entry) => entry.body.event_id === hookResult.eventId);
    expect(twin, "import never produced the hook's event_id").toBeDefined();

    // The whole point: same event_id AND same payload, so the server sees a plain
    // duplicate instead of a 409 that quarantines one side.
    expect(hookResult.event).toEqual(twin!.body);
    expect(hookResult.event).toMatchObject({
      event_id: deriveEventId(session, "u9"),
      session_title: "只在文件头出现的标题",
      prompt: "最后一个问题",
      reply: "最后一个回答",
      source_session_key: session,
    });
    // A cwd-basename fallback would have produced "long" instead.
    expect(hookResult.event?.session_title).not.toBe("long");
    expect(JSON.stringify(hookResult.event)).not.toContain("填");
  });

  test("keeps the first title after live sync when it begins beyond 64 KiB and a later rename is appended", async () => {
    const directory = await workspace();
    const projectsDir = join(directory, "projects");
    const session = "0b2c3d4e-1385-4b4b-9eb3-8edca841b114";
    const cwd = "/Users/camp/WorkBuddy/middle";

    const fillerRow = (marker: string) =>
      JSON.stringify({
        id: "fc",
        timestamp: 1_784_900_003_000,
        type: "function_call_result",
        name: "read_file",
        callId: "c",
        status: "completed",
        output: marker.repeat(4_000),
        sessionId: session,
        cwd,
      });

    // The first title is beyond the old 64 KiB head and then falls outside the
    // 256 KiB tail. A later rename must not change this already-derived event.
    const beforeTitle = Array.from({ length: 8 }, () => fillerRow("前")).join("\n");
    const middleTitle = JSON.stringify({
      id: "t",
      timestamp: 5,
      type: "ai-title",
      aiTitle: "中段首个标题",
      sessionId: session,
    });
    const afterTitle = Array.from({ length: 32 }, () => fillerRow("后")).join("\n");
    const lastRound = [
      userRow("u9", "中段标题会话的最后一个问题", 1_784_900_009_000, session, cwd),
      assistantRow("a9", "中段标题会话的最后一个回答", 1_784_900_010_000, session, cwd),
    ].join("\n");
    const body = `${beforeTitle}\n${middleTitle}\n${afterTitle}\n${lastRound}\n`;
    const transcriptPath = await writeSession(projectsDir, "middle", session, body);

    const titleStart = Buffer.byteLength(`${beforeTitle}\n`, "utf8");
    const total = Buffer.byteLength(body, "utf8");
    // Prove the fixture really puts the initial title outside both legacy windows.
    expect(titleStart).toBeGreaterThan(64 * 1024);
    expect(total - titleStart).toBeGreaterThan(256 * 1024);

    const hookState = join(directory, "hook-state");
    const hookResult = await runHook({
      stdinText: JSON.stringify({
        hook_event_name: "Stop",
        session_id: session,
        transcript_path: transcriptPath,
        cwd,
      }),
      env: {
        ...process.env,
        XDG_STATE_HOME: hookState,
        LOCALAPPDATA: hookState,
        WORKBUDDY_CONNECTOR_PATH: connectorPath,
      },
      temporaryDirectory: directory,
      log: () => undefined,
    });
    expect(hookResult.ok).toBe(true);

    await appendFile(
      transcriptPath,
      `${JSON.stringify({
        id: "renamed",
        timestamp: 6,
        type: "custom-title",
        customTitle: "后来重命名的标题",
        sessionId: session,
      })}\n`,
      "utf8",
    );

    const { connector, sent } = await configuredConnector(join(directory, "import-state"));
    const result = await runImport(connector, [
      "--projects-dir",
      projectsDir,
      "--throttle-ms",
      "0",
    ]);
    expect(result.code).toBe(0);

    const twin = sent.find((entry) => entry.body.event_id === hookResult.eventId);
    expect(twin, "import never produced the hook's event_id").toBeDefined();
    expect(hookResult.event).toEqual(twin!.body);
    expect(hookResult.event?.session_title).toBe("中段首个标题");
    expect(JSON.stringify(hookResult.event)).not.toContain("后来重命名的标题");
  });
});
