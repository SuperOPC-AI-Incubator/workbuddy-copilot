import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createWorkbuddyConnector,
  startWorkbuddyIpcServer,
  type WorkbuddyIpcServer,
} from "../../connectors/workbuddy-sync.mjs";

const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const MESSAGE_ID = "40000000-0000-4000-8000-000000000001";
const TOKEN = ["wb", "ipc", "credential", "that", "must", "not", "leak"].join("_");

const cleanupPaths: string[] = [];
const ipcServers: WorkbuddyIpcServer[] = [];
const childProcesses: ChildProcess[] = [];
const capabilityTokens = new Map<string, string>();

afterEach(async () => {
  capabilityTokens.clear();
  await Promise.all(ipcServers.splice(0).map((server) => server.close()));
  await Promise.all(
    childProcesses.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }),
  );
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function temporaryState(): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), "superbrain-ipc-"));
  cleanupPaths.push(stateDir);
  return stateDir;
}

function mentorMessage(id = MESSAGE_ID) {
  return {
    id,
    session_id: SESSION_ID,
    text: "导师的本地消息",
    author_username: "mentor",
    created_at: "2026-07-26T08:00:00.000Z",
    first_fetched_at: "2026-07-26T08:00:00.000Z",
    last_fetched_at: "2026-07-26T08:00:00.000Z",
    fetch_count: 1,
  };
}

async function configuredConnector(fetchImpl: typeof fetch, stateDir?: string) {
  const effectiveStateDir = stateDir ?? (await temporaryState());
  const connector = createWorkbuddyConnector({
    stateDir: effectiveStateDir,
    apiUrl: "https://copilot.example.test",
    fetchImpl,
    retryCount: 0,
    sleep: async () => undefined,
    jitter: () => 0,
  });
  await connector.configure({ apiUrl: "https://copilot.example.test", token: TOKEN });
  return connector;
}

async function startServer(
  connector: ReturnType<typeof createWorkbuddyConnector>,
  stateDir = connector.paths.root,
  options: { ackRetryDelayMs?: number; pollIntervalMs?: number } = {},
) {
  const server = await startWorkbuddyIpcServer({
    connector,
    endpoint: join(stateDir, "agent.ipc"),
    pollIntervalMs: options.pollIntervalMs ?? 60_000,
    ackRetryDelayMs: options.ackRetryDelayMs,
  });
  capabilityTokens.set(
    server.endpoint,
    (await readFile(join(stateDir, "ipc-capability.token"), "utf8")).trim(),
  );
  ipcServers.push(server);
  return server;
}

type Response =
  | { id: string; ok: true; result: Record<string, unknown> }
  | { id: string; ok: false; error: { code: string; message: string } };
type Push = { event: string; data: Record<string, unknown> };

class IpcClient {
  readonly rawLines: string[] = [];
  readonly pushes: Push[] = [];
  private readonly responses = new Map<string, (response: Response) => void>();
  private buffer = "";

  private constructor(
    private readonly socket: Socket,
    private readonly capabilityToken: string | null,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
  }

  static async connect(endpoint: string, capabilityToken = capabilityTokens.get(endpoint) ?? null) {
    const socket = createConnection(endpoint);
    await once(socket, "connect");
    return new IpcClient(socket, capabilityToken);
  }

  async request(op: string, params: Record<string, unknown> = {}): Promise<Response> {
    const id = crypto.randomUUID();
    const response = new Promise<Response>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.responses.delete(id);
        reject(new Error(`timed out waiting for ${op}`));
      }, 1_000);
      this.responses.set(id, (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
    });
    this.socket.write(`${JSON.stringify({ id, op, params })}\n`);
    return response;
  }

  async hello(protocolVersion = 1): Promise<Response> {
    return this.request("hello", {
      protocol_version: protocolVersion,
      ...(this.capabilityToken === null ? {} : { capability_token: this.capabilityToken }),
    });
  }

  async nextPush(event: string): Promise<Push> {
    await vi.waitFor(() => expect(this.pushes.some((push) => push.event === event)).toBe(true), {
      timeout: 1_000,
    });
    return this.pushes.find((push) => push.event === event)!;
  }

  close() {
    this.socket.destroy();
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw) continue;
      this.rawLines.push(raw);
      const parsed = JSON.parse(raw) as Response | Push;
      if ("event" in parsed) {
        this.pushes.push(parsed);
      } else {
        this.responses.get(parsed.id)?.(parsed);
        this.responses.delete(parsed.id);
      }
    }
  }
}

async function expectSilentUnauthorizedDisconnect(
  endpoint: string,
  params: Record<string, unknown>,
) {
  const socket = createConnection(endpoint);
  let received = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    received += chunk;
  });
  await once(socket, "connect");
  socket.write(`${JSON.stringify({ id: crypto.randomUUID(), op: "hello", params })}\n`);
  await Promise.race([
    once(socket, "close"),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("unauthorized socket stayed open")), 500),
    ),
  ]);
  expect(received).toBe("");
}

async function seedLedger(
  connector: ReturnType<typeof createWorkbuddyConnector>,
  fetchImpl: ReturnType<typeof vi.fn>,
) {
  fetchImpl.mockImplementationOnce(async () =>
    Response.json({
      ok: true,
      request_id: crypto.randomUUID(),
      messages: [mentorMessage()],
      next_cursor: null,
    }),
  );
  await connector.fetchMessages({});
}

describe("WorkBuddy agent IPC", () => {
  test("uses a constant-time comparison for the capability token", async () => {
    const source = await readFile(join(process.cwd(), "connectors", "workbuddy-sync.mjs"), "utf8");

    expect(source).toContain("timingSafeEqual(expected, received)");
  });

  test("silently disconnects a hello that omits the capability token", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    const server = await startServer(connector);

    await expectSilentUnauthorizedDisconnect(server.endpoint, {
      protocol_version: 1,
    });
  });

  test("silently disconnects a hello with the wrong capability token", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    const server = await startServer(connector);

    await expectSilentUnauthorizedDisconnect(server.endpoint, {
      protocol_version: 1,
      capability_token: ["wrong", "capability", "token"].join("-"),
    });
  });

  test("rejects incompatible protocol versions with a readable reason", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    const server = await startServer(connector);
    const client = await IpcClient.connect(server.endpoint);

    await expect(client.hello(2)).resolves.toMatchObject({
      ok: false,
      error: { code: "INCOMPATIBLE_PROTOCOL", message: expect.stringContaining("supports") },
    });
    client.close();
  });

  test("reads pending messages from the local ledger without a network request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    await seedLedger(connector, fetchImpl);
    fetchImpl.mockClear();
    const server = await startServer(connector);
    const client = await IpcClient.connect(server.endpoint);
    await client.hello();

    await expect(client.request("messages.pending")).resolves.toMatchObject({
      ok: true,
      result: { messages: [expect.objectContaining({ id: MESSAGE_ID })] },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    client.close();
  });

  test("drives one connector acknowledgement when two shells report the same message", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    await seedLedger(connector, fetchImpl);
    fetchImpl.mockClear();
    fetchImpl.mockImplementation(async (url, init) => {
      expect(String(url)).toContain("/mentor-messages/ack");
      expect(JSON.parse(String(init?.body))).toEqual({ message_ids: [MESSAGE_ID] });
      return Response.json({
        ok: true,
        request_id: crypto.randomUUID(),
        acknowledged: [{ id: MESSAGE_ID, acknowledged_at: "2026-07-26T08:01:00.000Z" }],
      });
    });
    const server = await startServer(connector);
    const first = await IpcClient.connect(server.endpoint);
    const second = await IpcClient.connect(server.endpoint);
    await Promise.all([first.hello(), second.hello()]);

    await expect(
      Promise.all([
        first.request("messages.displayed", { message_ids: [MESSAGE_ID] }),
        second.request("messages.displayed", { message_ids: [MESSAGE_ID] }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    first.close();
    second.close();
  });

  test("rejects a token-bearing operation sent before hello", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    const server = await startServer(connector);
    const client = await IpcClient.connect(server.endpoint);

    await expect(
      client.request("status", {
        capability_token: capabilityTokens.get(server.endpoint),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "HELLO_REQUIRED" },
    });
    client.close();
  });

  test("accepts displayed immediately, hides it from pending, and acks in the background", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    await seedLedger(connector, fetchImpl);
    fetchImpl.mockClear();
    let ackStarted = false;
    let releaseAck!: () => void;
    const ackGate = new Promise<void>((resolveAck) => {
      releaseAck = resolveAck;
    });
    fetchImpl.mockImplementation(async () => {
      ackStarted = true;
      await ackGate;
      return Response.json({
        ok: true,
        request_id: crypto.randomUUID(),
        acknowledged: [{ id: MESSAGE_ID, acknowledged_at: "2026-07-26T08:01:00.000Z" }],
      });
    });
    const server = await startServer(connector);
    const client = await IpcClient.connect(server.endpoint);
    await client.hello();

    const displayed = client.request("messages.displayed", { message_ids: [MESSAGE_ID] });
    await vi.waitFor(() => expect(ackStarted).toBe(true));
    try {
      await expect(displayed).resolves.toMatchObject({
        ok: true,
        result: { accepted: [MESSAGE_ID] },
      });
      await expect(client.request("messages.pending")).resolves.toMatchObject({
        ok: true,
        result: { messages: [] },
      });
    } finally {
      releaseAck();
    }
    client.close();
  });

  test("retries a background acknowledgement without making the shell wait", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    await seedLedger(connector, fetchImpl);
    fetchImpl.mockClear();
    let acknowledgementAttempts = 0;
    fetchImpl.mockImplementation(async () => {
      acknowledgementAttempts += 1;
      if (acknowledgementAttempts === 1) throw new Error("temporary upstream failure");
      return Response.json({
        ok: true,
        request_id: crypto.randomUUID(),
        acknowledged: [{ id: MESSAGE_ID, acknowledged_at: "2026-07-26T08:01:00.000Z" }],
      });
    });
    const server = await startServer(connector, connector.paths.root, { ackRetryDelayMs: 100 });
    const client = await IpcClient.connect(server.endpoint);
    await client.hello();

    await expect(
      client.request("messages.displayed", { message_ids: [MESSAGE_ID] }),
    ).resolves.toMatchObject({ ok: true, result: { accepted: [MESSAGE_ID] } });
    await vi.waitFor(() => expect(acknowledgementAttempts).toBe(2), { timeout: 1_000 });
    client.close();
  });

  test("reads a legacy ledger entry that has no shell-display field", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    await writeFile(
      join(connector.paths.renderLedger, "ledger.json"),
      `${JSON.stringify({
        version: 1,
        messages: {
          [MESSAGE_ID]: {
            id: MESSAGE_ID,
            session_id: SESSION_ID,
            text: "旧账本导师消息",
            author_username: "mentor",
            created_at: "2026-07-26T08:00:00.000Z",
            rendered_at: "2026-07-26T08:00:00.000Z",
            acked_at: null,
          },
        },
      })}\n`,
    );
    const server = await startServer(connector);
    const client = await IpcClient.connect(server.endpoint);
    await client.hello();

    await expect(client.request("messages.pending")).resolves.toMatchObject({
      ok: true,
      result: { messages: [expect.objectContaining({ id: MESSAGE_ID })] },
    });
    client.close();
  });

  test("pushes a delivery status change after an acknowledgement succeeds", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    await seedLedger(connector, fetchImpl);
    fetchImpl.mockClear();
    fetchImpl.mockImplementation(async () =>
      Response.json({
        ok: true,
        request_id: crypto.randomUUID(),
        acknowledged: [{ id: MESSAGE_ID, acknowledged_at: "2026-07-26T08:01:00.000Z" }],
      }),
    );
    const server = await startServer(connector);
    const client = await IpcClient.connect(server.endpoint);
    await client.hello();
    await client.request("subscribe");

    await expect(
      client.request("messages.displayed", { message_ids: [MESSAGE_ID] }),
    ).resolves.toMatchObject({
      ok: true,
    });
    await expect(client.nextPush("status.changed")).resolves.toMatchObject({
      data: { delivery: { acknowledged: 1, awaiting_ack: 0 } },
    });
    client.close();
  });

  test("returns UNKNOWN_OP for an operation the agent does not recognise", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    const server = await startServer(connector);
    const client = await IpcClient.connect(server.endpoint);
    await client.hello();

    await expect(client.request("not.in.contract")).resolves.toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_OP" },
    });
    client.close();
  });

  test("never puts the configured credential in any IPC response or push", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    const server = await startServer(connector);
    const client = await IpcClient.connect(server.endpoint);

    await client.hello();
    await client.request("status");
    await client.request("messages.pending");
    await client.request("subscribe");
    expect(client.rawLines.join("\n")).not.toContain(TOKEN);
    client.close();
  });

  test("pushes new messages and health changes only after a shell subscribes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        request_id: crypto.randomUUID(),
        messages: [mentorMessage()],
        next_cursor: null,
      }),
    );
    const connector = await configuredConnector(fetchImpl);
    const server = await startWorkbuddyIpcServer({
      connector,
      endpoint: join(connector.paths.root, "agent.ipc"),
      pollIntervalMs: 100,
    });
    ipcServers.push(server);
    capabilityTokens.set(
      server.endpoint,
      (await readFile(join(connector.paths.root, "ipc-capability.token"), "utf8")).trim(),
    );
    const client = await IpcClient.connect(server.endpoint);
    await client.hello();
    await client.request("subscribe");

    await expect(client.nextPush("message.new")).resolves.toMatchObject({
      data: { message: expect.objectContaining({ id: MESSAGE_ID }) },
    });
    await expect(client.nextPush("status.changed")).resolves.toMatchObject({
      data: { connection: { state: "online" } },
    });
    client.close();
  });

  test("creates the POSIX endpoint with mode 0600", async () => {
    if (process.platform === "win32") return;
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    const server = await startServer(connector);

    expect((await stat(server.endpoint)).mode & 0o777).toBe(0o600);
  });

  test("takes over a crashed process's stale socket endpoint safely", async () => {
    if (process.platform === "win32") return;
    const stateDir = await temporaryState();
    const endpoint = join(stateDir, "agent.ipc");
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const net=require('node:net'); const s=net.createServer(); s.listen(process.argv[1],()=>process.stdout.write('ready\\n')); setInterval(()=>{},1000);",
        endpoint,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    childProcesses.push(child);
    await once(child.stdout!, "data");
    child.kill("SIGKILL");
    await once(child, "exit");

    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl, stateDir);
    const server = await startServer(connector, stateDir);
    const client = await IpcClient.connect(server.endpoint);
    await expect(client.hello()).resolves.toMatchObject({ ok: true });
    client.close();
  });

  test("rejects a second agent while the private endpoint is active", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    const server = await startServer(connector);

    await expect(
      startWorkbuddyIpcServer({
        connector,
        endpoint: server.endpoint,
        pollIntervalMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: "IPC_ENDPOINT_IN_USE" });
  });

  test("refuses an endpoint outside the connector's private state directory", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);

    await expect(
      startWorkbuddyIpcServer({
        connector,
        endpoint: join(connector.paths.root, "..", "outside-agent.ipc"),
        pollIntervalMs: 60_000,
      }),
    ).rejects.toMatchObject({ code: "IPC_ENDPOINT_OUTSIDE_STATE_DIR" });
  });

  test("serializes competing recovery of one stale socket endpoint", async () => {
    if (process.platform === "win32") return;
    const stateDir = await temporaryState();
    const endpoint = join(stateDir, "agent.ipc");
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const net=require('node:net'); const s=net.createServer(); s.listen(process.argv[1],()=>process.stdout.write('ready\\n')); setInterval(()=>{},1000);",
        endpoint,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    childProcesses.push(child);
    await once(child.stdout!, "data");
    child.kill("SIGKILL");
    await once(child, "exit");

    const fetchImpl = vi.fn<typeof fetch>();
    const first = await configuredConnector(fetchImpl, stateDir);
    const second = createWorkbuddyConnector({
      stateDir,
      fetchImpl,
      retryCount: 0,
      sleep: async () => undefined,
      jitter: () => 0,
    });
    const outcomes = await Promise.allSettled([
      startWorkbuddyIpcServer({ connector: first, endpoint, pollIntervalMs: 60_000 }),
      startWorkbuddyIpcServer({ connector: second, endpoint, pollIntervalMs: 60_000 }),
    ]);
    const started = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<WorkbuddyIpcServer> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );

    expect(started).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "IPC_ENDPOINT_IN_USE" });
    ipcServers.push(started[0]!.value);
  });

  test("pushes agent.shutdown to subscribed shells before closing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const connector = await configuredConnector(fetchImpl);
    const server = await startServer(connector);
    const client = await IpcClient.connect(server.endpoint);
    await client.hello();
    await client.request("subscribe");

    await server.close();
    await expect(client.nextPush("agent.shutdown")).resolves.toMatchObject({
      data: expect.objectContaining({ reason: "shutdown" }),
    });
    client.close();
  });

  test("the ipc command publishes its endpoint and exits gracefully on SIGTERM", async () => {
    const stateHome = await temporaryState();
    const fetchImpl = vi.fn<typeof fetch>();
    await configuredConnector(fetchImpl, join(stateHome, "superbrain-copilot"));
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "connectors", "workbuddy-sync.mjs"), "ipc"],
      {
        env: { ...process.env, XDG_STATE_HOME: stateHome },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    childProcesses.push(child);
    const [stdout] = (await once(child.stdout!, "data")) as [Buffer];
    const started = JSON.parse(stdout.toString("utf8")) as { endpoint: string };
    const client = await IpcClient.connect(
      started.endpoint,
      (
        await readFile(join(stateHome, "superbrain-copilot", "ipc-capability.token"), "utf8")
      ).trim(),
    );
    await client.hello();
    await client.request("subscribe");

    const childExit = once(child, "exit");
    child.kill("SIGTERM");
    await expect(client.nextPush("agent.shutdown")).resolves.toMatchObject({
      data: { reason: "shutdown" },
    });
    await expect(childExit).resolves.toEqual([0, null]);
    client.close();
  });
});
