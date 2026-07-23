import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  ReliableWorkbuddyTurnSchema,
  canonicalWorkbuddyPayload,
  stableJsonStringify,
  type ReliableWorkbuddyTurn,
} from "@/lib/workbuddy/contracts";
import {
  WorkbuddyEventConflictError,
  ingestWorkbuddyTurn,
  sha256Hex,
  type IngestWorkbuddyTurnGateway,
  type WorkbuddyIngestRpcArgs,
} from "@/lib/workbuddy/events.server";
import {
  InvalidWorkbuddyCredentialError,
  MissingWorkbuddyCredentialError,
  RevokedWorkbuddyCredentialError,
  WorkbuddyCredentialGatewayError,
  resolveWorkbuddyCredential,
  type WorkbuddyCredentialGateway,
} from "@/lib/workbuddy/credentials.server";
import {
  MAX_WORKBUDDY_INGEST_BODY_BYTES,
  createWorkbuddyIngestPostHandler,
} from "@/routes/api/public/workbuddy/ingest";

const EVENT_ID = "20000000-0000-4000-8000-000000000001";
const STUDENT_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_STUDENT_ID = "10000000-0000-4000-8000-000000000002";

function reliableTurn(overrides: Partial<ReliableWorkbuddyTurn> = {}): ReliableWorkbuddyTurn {
  return {
    event_id: EVENT_ID,
    source: "connector",
    source_session_key: "machine-a/session-42",
    session_title: "Same visible title",
    prompt: "How do I reset this PLC?",
    reply: "First isolate the machine.",
    diagnosis: {
      text: "The learner skipped the isolation step.",
      severity: "warn",
    },
    client_created_at: "2026-07-23T09:00:00.000Z",
    ...overrides,
  };
}

function rpcResult(overrides: Record<string, unknown> = {}) {
  return {
    event_id: EVENT_ID,
    student_id: STUDENT_ID,
    session_id: "30000000-0000-4000-8000-000000000001",
    prompt_item_id: "40000000-0000-4000-8000-000000000001",
    reply_item_id: "40000000-0000-4000-8000-000000000002",
    diagnosis_item_id: "40000000-0000-4000-8000-000000000003",
    duplicate: false,
    ...overrides,
  };
}

class RecordingIngestGateway implements IngestWorkbuddyTurnGateway {
  readonly calls: WorkbuddyIngestRpcArgs[] = [];
  response: { data: unknown; error: { code?: string; message?: string } | null } = {
    data: rpcResult(),
    error: null,
  };

  async ingestWorkbuddyTurn(args: WorkbuddyIngestRpcArgs) {
    this.calls.push(args);
    return this.response;
  }
}

describe("reliable WorkBuddy turn contract", () => {
  test("accepts only the bounded prompt/reply/diagnosis reliable shape", () => {
    expect(ReliableWorkbuddyTurnSchema.parse(reliableTurn())).toEqual(reliableTurn());

    for (const injected of [
      { student_id: STUDENT_ID },
      { session_id: "30000000-0000-4000-8000-000000000001" },
      { kind: "mentor" },
      { items: [{ kind: "mentor", text: "forged" }] },
    ]) {
      expect(() => ReliableWorkbuddyTurnSchema.parse({ ...reliableTurn(), ...injected })).toThrow();
    }

    expect(() =>
      ReliableWorkbuddyTurnSchema.parse(reliableTurn({ source_session_key: " ".repeat(3) })),
    ).toThrow();
    expect(() =>
      ReliableWorkbuddyTurnSchema.parse(reliableTurn({ source_session_key: "x".repeat(256) })),
    ).toThrow();
    expect(() =>
      ReliableWorkbuddyTurnSchema.parse(reliableTurn({ prompt: "x".repeat(4_001) })),
    ).toThrow();
    expect(() =>
      ReliableWorkbuddyTurnSchema.parse(reliableTurn({ reply: "x".repeat(8_001) })),
    ).toThrow();
  });

  test("canonical serialization is recursively key-order stable", () => {
    const first = {
      z: [{ b: 2, a: 1 }],
      a: { y: "two", x: "one" },
    };
    const second = {
      a: { x: "one", y: "two" },
      z: [{ a: 1, b: 2 }],
    };

    expect(stableJsonStringify(first)).toBe(stableJsonStringify(second));
    expect(stableJsonStringify({ z: 1, ä: 2, a: 3 })).toBe('{"a":3,"z":1,"ä":2}');
  });

  test("hash payload explicitly excludes event and student identity", () => {
    const canonical = canonicalWorkbuddyPayload(reliableTurn());

    expect(canonical).toEqual({
      contract_version: 1,
      source: "connector",
      source_session_key: "machine-a/session-42",
      session_title: "Same visible title",
      prompt: "How do I reset this PLC?",
      reply: "First isolate the machine.",
      diagnosis: {
        text: "The learner skipped the isolation step.",
        severity: "warn",
      },
      client_created_at: "2026-07-23T09:00:00.000Z",
    });
    expect(stableJsonStringify(canonical)).not.toContain(EVENT_ID);
    expect(stableJsonStringify(canonical)).not.toContain(STUDENT_ID);
  });
});

describe("WorkBuddy event service", () => {
  test("calls the atomic RPC exactly once and returns stable item ids", async () => {
    const gateway = new RecordingIngestGateway();
    const sha256 = vi.fn(() => "a".repeat(64));

    const result = await ingestWorkbuddyTurn(
      { studentId: STUDENT_ID, turn: reliableTurn() },
      { gateway, sha256 },
    );

    expect(gateway.calls).toEqual([
      {
        _event_id: EVENT_ID,
        _student_id: STUDENT_ID,
        _source: "connector",
        _source_session_key: "machine-a/session-42",
        _session_title: "Same visible title",
        _payload_sha256: "a".repeat(64),
        _prompt: "How do I reset this PLC?",
        _reply: "First isolate the machine.",
        _diagnosis_text: "The learner skipped the isolation step.",
        _diagnosis_severity: "warn",
        _client_created_at: "2026-07-23T09:00:00.000Z",
      },
    ]);
    expect(sha256).toHaveBeenCalledOnce();
    expect(result).toEqual(rpcResult());
  });

  test("uses the production SHA-256 for a fixed canonical turn", async () => {
    const gateway = new RecordingIngestGateway();
    const canonical =
      '{"client_created_at":"2026-07-23T09:00:00.000Z","contract_version":1,"diagnosis":{"severity":"warn","text":"The learner skipped the isolation step."},"prompt":"How do I reset this PLC?","reply":"First isolate the machine.","session_title":"Same visible title","source":"connector","source_session_key":"machine-a/session-42"}';
    const expectedHash = "fd7032c13dd823221de6ec9ccd1730b0f72c1fdea99fb76ad3bab1e63c3e6260";

    expect(stableJsonStringify(canonicalWorkbuddyPayload(reliableTurn()))).toBe(canonical);
    expect(sha256Hex(canonical)).toBe(expectedHash);

    await ingestWorkbuddyTurn({ studentId: STUDENT_ID, turn: reliableTurn() }, { gateway });
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]?._payload_sha256).toBe(expectedHash);
  });

  test("same event returns the stored ids while a changed payload is a stable conflict", async () => {
    const gateway = new RecordingIngestGateway();
    gateway.response = { data: rpcResult({ duplicate: true }), error: null };

    await expect(
      ingestWorkbuddyTurn(
        { studentId: STUDENT_ID, turn: reliableTurn() },
        { gateway, sha256: () => "a".repeat(64) },
      ),
    ).resolves.toEqual(rpcResult({ duplicate: true }));

    gateway.response = {
      data: null,
      error: { code: "P4090", message: "workbuddy_event_conflict" },
    };

    await expect(
      ingestWorkbuddyTurn(
        { studentId: STUDENT_ID, turn: reliableTurn({ prompt: "changed" }) },
        { gateway, sha256: () => "b".repeat(64) },
      ),
    ).rejects.toBeInstanceOf(WorkbuddyEventConflictError);
    expect(gateway.calls).toHaveLength(2);
  });

  test("rejects a gateway result owned by another student", async () => {
    const gateway = new RecordingIngestGateway();
    gateway.response = {
      data: rpcResult({ student_id: OTHER_STUDENT_ID }),
      error: null,
    };

    await expect(
      ingestWorkbuddyTurn(
        { studentId: STUDENT_ID, turn: reliableTurn() },
        { gateway, sha256: () => "a".repeat(64) },
      ),
    ).rejects.toThrow("WORKBUDDY_RESULT_OWNERSHIP_MISMATCH");
  });
});

describe("WorkBuddy bearer credentials", () => {
  test("hashes only the presented token and resolves its active student", async () => {
    const gateway: WorkbuddyCredentialGateway = {
      resolveWorkbuddyCredentialHash: vi.fn(async () => ({
        data: { status: "active", student_id: STUDENT_ID },
        error: null,
      })),
    };
    const sha256 = vi.fn(() => "c".repeat(64));

    await expect(
      resolveWorkbuddyCredential("wb_secret_presented_once", { gateway, sha256 }),
    ).resolves.toEqual({ studentId: STUDENT_ID });
    expect(sha256).toHaveBeenCalledWith("wb_secret_presented_once");
    expect(gateway.resolveWorkbuddyCredentialHash).toHaveBeenCalledWith("c".repeat(64));
  });

  test("keeps invalid and revoked credentials distinguishable internally", async () => {
    const invalidGateway: WorkbuddyCredentialGateway = {
      resolveWorkbuddyCredentialHash: async () => ({
        data: { status: "invalid" },
        error: null,
      }),
    };
    const revokedGateway: WorkbuddyCredentialGateway = {
      resolveWorkbuddyCredentialHash: async () => ({
        data: { status: "revoked" },
        error: null,
      }),
    };

    await expect(
      resolveWorkbuddyCredential("", {
        gateway: invalidGateway,
        sha256: () => "f".repeat(64),
      }),
    ).rejects.toBeInstanceOf(MissingWorkbuddyCredentialError);
    await expect(
      resolveWorkbuddyCredential("invalid", {
        gateway: invalidGateway,
        sha256: () => "d".repeat(64),
      }),
    ).rejects.toBeInstanceOf(InvalidWorkbuddyCredentialError);
    await expect(
      resolveWorkbuddyCredential("revoked", {
        gateway: revokedGateway,
        sha256: () => "e".repeat(64),
      }),
    ).rejects.toBeInstanceOf(RevokedWorkbuddyCredentialError);
  });

  test.each([
    ["null", null],
    ["missing status", {}],
    ["unknown status", { status: "rotated" }],
    ["active without a valid student UUID", { status: "active", student_id: "not-a-uuid" }],
    ["version-drifted invalid result", { status: "invalid", version: 2 }],
  ])("treats malformed RPC result (%s) as a credential gateway failure", async (_label, data) => {
    const gateway: WorkbuddyCredentialGateway = {
      resolveWorkbuddyCredentialHash: async () => ({ data, error: null }),
    };

    await expect(
      resolveWorkbuddyCredential("presented", {
        gateway,
        sha256: () => "f".repeat(64),
      }),
    ).rejects.toBeInstanceOf(WorkbuddyCredentialGatewayError);
  });
});

describe("public WorkBuddy ingest route", () => {
  function makeHandler(
    overrides: {
      resolveCredential?: (token: string) => Promise<{ studentId: string }>;
      ingestTurn?: (
        input: Parameters<typeof ingestWorkbuddyTurn>[0],
      ) => ReturnType<typeof ingestWorkbuddyTurn>;
    } = {},
  ) {
    return createWorkbuddyIngestPostHandler({
      resolveCredential: overrides.resolveCredential ?? (async () => ({ studentId: STUDENT_ID })),
      ingestTurn: overrides.ingestTurn ?? (async () => rpcResult()),
    });
  }

  function request(body: string, authorization = "Bearer wb_presented") {
    return new Request("http://localhost/api/public/workbuddy/ingest", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body,
    });
  }

  function streamingRequest(chunks: Uint8Array[], authorization = "Bearer wb_presented") {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body,
      duplex: "half",
    };
    return new Request("http://localhost/api/public/workbuddy/ingest", init);
  }

  test("authenticates first and maps the token-owned student into the service", async () => {
    const resolveCredential = vi.fn(async () => ({ studentId: STUDENT_ID }));
    const ingestTurn = vi.fn(async () => rpcResult());
    const response = await makeHandler({
      resolveCredential,
      ingestTurn,
    })(request(JSON.stringify(reliableTurn())));

    expect(response.status).toBe(200);
    expect(resolveCredential).toHaveBeenCalledWith("wb_presented");
    expect(ingestTurn).toHaveBeenCalledWith({
      studentId: STUDENT_ID,
      turn: reliableTurn(),
    });
    expect(await response.json()).toEqual({
      ok: true,
      event_id: EVENT_ID,
      session_id: "30000000-0000-4000-8000-000000000001",
      item_ids: {
        prompt: "40000000-0000-4000-8000-000000000001",
        reply: "40000000-0000-4000-8000-000000000002",
        diagnosis: "40000000-0000-4000-8000-000000000003",
      },
      duplicate: false,
    });
  });

  test.each([
    ["missing", "", InvalidWorkbuddyCredentialError],
    ["invalid", "Bearer invalid", InvalidWorkbuddyCredentialError],
    ["revoked", "Bearer revoked", RevokedWorkbuddyCredentialError],
  ])("returns one sanitized 401 response for %s auth", async (_label, authorization, ErrorType) => {
    const response = await makeHandler({
      resolveCredential: async () => {
        throw new ErrorType();
      },
    })(request(JSON.stringify(reliableTurn()), authorization));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "Invalid WorkBuddy credential" },
    });
  });

  test("returns a sanitized 500 when the credential RPC response shape drifts", async () => {
    const gateway: WorkbuddyCredentialGateway = {
      resolveWorkbuddyCredentialHash: async () => ({
        data: { status: "invalid", version: 2 },
        error: null,
      }),
    };
    const response = await makeHandler({
      resolveCredential: (token) =>
        resolveWorkbuddyCredential(token, {
          gateway,
          sha256: () => "f".repeat(64),
        }),
    })(request(JSON.stringify(reliableTurn())));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  });

  test("rejects oversized bodies before JSON parsing", async () => {
    const resolveCredential = vi.fn(async () => ({ studentId: STUDENT_ID }));
    const response = await makeHandler({ resolveCredential })(
      request("x".repeat(MAX_WORKBUDDY_INGEST_BODY_BYTES + 1)),
    );

    expect(response.status).toBe(413);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Payload too large" },
    });
  });

  test.each([
    ["malformed JSON", "{"],
    ["validation failure", JSON.stringify({ ...reliableTurn(), kind: "mentor" })],
  ])("returns sanitized 400 for %s", async (_label, body) => {
    const response = await makeHandler()(request(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_PAYLOAD", message: "Invalid WorkBuddy payload" },
    });
  });

  test("returns sanitized 400 for invalid UTF-8 split across streamed chunks", async () => {
    const resolveCredential = vi.fn(async () => ({ studentId: STUDENT_ID }));
    const response = await makeHandler({ resolveCredential })(
      streamingRequest([
        new TextEncoder().encode('{"prompt":"'),
        new Uint8Array([0xc3]),
        new Uint8Array([0x28]),
      ]),
    );

    expect(response.status).toBe(400);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: { code: "INVALID_PAYLOAD", message: "Invalid WorkBuddy payload" },
    });
  });

  test("maps event conflicts to 409 and sanitizes unknown failures", async () => {
    const conflict = await makeHandler({
      ingestTurn: async () => {
        throw new WorkbuddyEventConflictError();
      },
    })(request(JSON.stringify(reliableTurn())));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: { code: "EVENT_ID_CONFLICT", message: "Event ID conflicts with stored payload" },
    });

    const failure = await makeHandler({
      ingestTurn: async () => {
        throw new Error("database host and secret must never be returned");
      },
    })(request(JSON.stringify(reliableTurn())));
    expect(failure.status).toBe(500);
    expect(JSON.stringify(await failure.json())).toBe(
      JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }),
    );
  });
});

describe("database and MCP reliability guardrails", () => {
  const migration = readFileSync(
    resolve(process.cwd(), "supabase/migrations/20260723090100_cloud_integration.sql"),
    "utf8",
  );
  const logTurn = readFileSync(resolve(process.cwd(), "src/lib/mcp/tools/log-turn.ts"), "utf8");

  test("credential resolution is service-role-only and never reads students.workbuddy_token", () => {
    expect(migration).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.resolve_workbuddy_credential\s*\(/i,
    );
    expect(migration).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.resolve_workbuddy_credential\s*\([^;]*\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated/i,
    );
    expect(migration).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.resolve_workbuddy_credential\s*\([^;]*\)\s+TO\s+service_role/i,
    );
    const resolver = migration.slice(
      migration.search(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.resolve_workbuddy_credential/i),
      migration.search(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.ingest_workbuddy_turn/i),
    );
    expect(resolver).toMatch(
      /UPDATE\s+public\.workbuddy_credentials[\s\S]*?last_used_at[\s\S]*?status\s*=\s*'active'/i,
    );
    expect(resolver).toMatch(
      /jsonb_build_object\s*\(\s*'status'\s*,\s*'active'\s*,\s*'student_id'/i,
    );
    expect(resolver).toMatch(
      /resolved_status\s*=\s*'revoked'[\s\S]*?jsonb_build_object\s*\(\s*'status'\s*,\s*'revoked'/i,
    );
    expect(resolver).toMatch(
      /RETURN\s+pg_catalog\.jsonb_build_object\s*\(\s*'status'\s*,\s*'invalid'\s*\)/i,
    );
    expect(resolver).not.toMatch(/students\.workbuddy_token/i);
  });

  test("RPC owns event-first atomicity, unique source sessions, and mentor rejection", () => {
    const ingestStart = migration.search(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.ingest_workbuddy_turn\s*\(/i,
    );
    const ingestEnd = migration.indexOf(
      "REVOKE ALL ON FUNCTION public.ingest_workbuddy_turn",
      ingestStart,
    );
    const ingest = migration.slice(ingestStart, ingestEnd);
    const eventClaim = ingest.search(/INSERT\s+INTO\s+public\.workbuddy_ingest_events\s*\(/i);
    const sessionWrite = ingest.search(
      /INSERT\s+INTO\s+public\.sessions\s*\(\s*student_id\s*,\s*session_title\s*,\s*source/i,
    );
    expect(ingestStart).toBeGreaterThanOrEqual(0);
    expect(ingestEnd).toBeGreaterThan(ingestStart);
    expect(eventClaim).toBeGreaterThanOrEqual(0);
    expect(sessionWrite).toBeGreaterThan(eventClaim);
    expect(migration).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+sessions_student_source_key_unique\s+ON\s+public\.sessions\s*\(\s*student_id\s*,\s*source\s*,\s*source_session_key\s*\)\s+WHERE\s+source_session_key\s+IS\s+NOT\s+NULL/i,
    );
    expect(ingest).toMatch(/_source\s+NOT\s+IN\s*\(\s*'mcp'\s*,\s*'skill'\s*,\s*'connector'\s*\)/i);
    expect(ingest).toMatch(
      /'prompt'::public\.timeline_kind[\s\S]*?0[\s\S]*?'reply'::public\.timeline_kind[\s\S]*?1[\s\S]*?'diagnosis'::public\.timeline_kind[\s\S]*?2/i,
    );
  });

  test("MCP requires stable client identities and delegates to the shared event service", () => {
    expect(logTurn).toMatch(/event_id:\s*z\.string\(\)\.uuid\(\)/);
    expect(logTurn).toMatch(/source_session_key:\s*z\s*\.string\(\)/);
    expect(logTurn).toMatch(/ingestWorkbuddyTurn\s*\(/);
    expect(logTurn).not.toMatch(/session_id:\s*z\./);
    expect(logTurn).not.toMatch(/\.from\(\s*["']timeline_items["']\s*\)\.insert/);
    expect(logTurn).not.toMatch(/\.from\(\s*["']sessions["']\s*\)/);
  });
});
