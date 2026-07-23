import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, expectTypeOf, test } from "vitest";
import { Constants, type Database, type Json } from "@/integrations/supabase/types";

const migrationsDirectory = resolve(process.cwd(), "supabase/migrations");
const roleMigrationPath = resolve(migrationsDirectory, "20260723090000_add_team_admin_role.sql");
const cloudMigrationPath = resolve(migrationsDirectory, "20260723090100_cloud_integration.sql");
const staffAuthCompatibilityMigrationPath = resolve(
  migrationsDirectory,
  "20260724000000_staff_auth_provider_compat.sql",
);
const deliveryMigrationPath = resolve(migrationsDirectory, "20260723090300_reliable_delivery.sql");
const mentorSendMigrationPath = resolve(
  migrationsDirectory,
  "20260723090400_delivery_status_and_mentor_send.sql",
);
const generatedTypesPath = resolve(process.cwd(), "src/integrations/supabase/types.ts");
const pgTapPath = resolve(process.cwd(), "supabase/tests/cloud_integration_test.sql");
const concurrencyTestPath = resolve(
  process.cwd(),
  "tests/integration/workbuddy-concurrency.test.ts",
);
const mentorDeskPath = resolve(process.cwd(), "src/routes/_authenticated/index.tsx");

const roleMigration = readFileSync(roleMigrationPath, "utf8");
const cloudMigration = readFileSync(cloudMigrationPath, "utf8");
const staffAuthCompatibilityMigration = readFileSync(staffAuthCompatibilityMigrationPath, "utf8");
const deliveryMigration = readFileSync(deliveryMigrationPath, "utf8");
const mentorSendMigration = readFileSync(mentorSendMigrationPath, "utf8");
const generatedTypes = readFileSync(generatedTypesPath, "utf8");
const pgTap = readFileSync(pgTapPath, "utf8");
const concurrencyTest = readFileSync(concurrencyTestPath, "utf8");
const mentorDesk = readFileSync(mentorDeskPath, "utf8");

type ExpectedFoundationTables = {
  staff_accounts: Database["public"]["Tables"]["staff_accounts"];
  workbuddy_ingest_events: Database["public"]["Tables"]["workbuddy_ingest_events"];
  workbuddy_credentials: Database["public"]["Tables"]["workbuddy_credentials"];
  mentor_message_deliveries: Database["public"]["Tables"]["mentor_message_deliveries"];
};

const generatedTableContract: Record<keyof ExpectedFoundationTables, true> = {
  staff_accounts: true,
  workbuddy_ingest_events: true,
  workbuddy_credentials: true,
  mentor_message_deliveries: true,
};

const newTableColumns = {
  staff_accounts: [
    "user_id",
    "username",
    "normalized_username",
    "auth_identity_version",
    "is_active",
    "must_change_password",
    "created_by",
    "disabled_at",
    "disabled_by",
    "created_at",
    "updated_at",
  ],
  workbuddy_ingest_events: [
    "event_id",
    "student_id",
    "session_id",
    "source",
    "payload_sha256",
    "client_created_at",
    "result",
    "created_at",
  ],
  workbuddy_credentials: [
    "id",
    "student_id",
    "token_hash",
    "token_prefix",
    "source",
    "status",
    "last_used_at",
    "revoked_at",
    "created_at",
  ],
  mentor_message_deliveries: [
    "message_id",
    "student_id",
    "session_id",
    "first_fetched_at",
    "last_fetched_at",
    "fetch_count",
    "acknowledged_at",
    "web_seen_at",
    "failure_count",
    "last_error_code",
    "created_at",
    "updated_at",
  ],
} as const;

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
    .trim();
}

function createTableBody(sql: string, table: string): string {
  const match = sql.match(
    new RegExp(`CREATE\\s+TABLE\\s+public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i"),
  );

  expect(match, `missing CREATE TABLE public.${table}`).not.toBeNull();
  return match?.[1] ?? "";
}

function columnNames(tableBody: string): string[] {
  return tableBody
    .split("\n")
    .map((line) => line.trim())
    .map(
      (line) =>
        line.match(
          /^([a-z_][a-z0-9_]*)\s+(?:uuid|text|integer|boolean|timestamptz|jsonb|smallint)\b/i,
        )?.[1],
    )
    .filter((column): column is string => column !== undefined);
}

function expectColumnDefinition(tableBody: string, pattern: RegExp): void {
  expect(tableBody).toMatch(pattern);
}

function functionDefinition(sql: string, functionName: string): string {
  const startPattern = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${functionName}\\s*\\(`,
    "i",
  );
  const start = sql.search(startPattern);

  expect(start, `missing function public.${functionName}`).toBeGreaterThanOrEqual(0);

  const remainingSql = sql.slice(start + 1);
  const nextFunctionOffset = remainingSql.search(
    /\nCREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.[a-z_]+\s*\(/i,
  );
  const end = nextFunctionOffset === -1 ? sql.length : start + 1 + nextFunctionOffset;

  return sql.slice(start, end);
}

function expectRevokedFromClients(functionName: string): void {
  expect(cloudMigration).toMatch(
    new RegExp(
      `REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${functionName}\\s*\\([^;]*\\)\\s+FROM\\s+PUBLIC\\s*,\\s*anon\\s*,\\s*authenticated`,
      "i",
    ),
  );
}

describe("cloud integration schema contract", () => {
  test("keeps generated Supabase types aligned with the foundation migration", () => {
    expect(Constants.public.Enums.app_role).toContain("team_admin");
    expect(Object.keys(generatedTableContract)).toEqual(Object.keys(newTableColumns));
  });

  test("keeps every Task 3 generated type shape exact", () => {
    expectTypeOf<Database["public"]["Tables"]["staff_accounts"]["Row"]>().toEqualTypeOf<{
      active_operation_desired: boolean | null;
      active_operation_token: string | null;
      active_state_version: number;
      auth_identity_version: number;
      created_at: string;
      created_by: string | null;
      disabled_at: string | null;
      disabled_by: string | null;
      is_active: boolean;
      must_change_password: boolean;
      normalized_username: string;
      password_reset_operation_token: string | null;
      password_reset_previous_must_change: boolean | null;
      updated_at: string;
      user_id: string;
      username: string;
    }>();
    expectTypeOf<Database["public"]["Tables"]["staff_accounts"]["Insert"]>().toEqualTypeOf<{
      active_operation_desired?: boolean | null;
      active_operation_token?: string | null;
      active_state_version?: number;
      auth_identity_version?: number;
      created_at?: string;
      created_by?: string | null;
      disabled_at?: string | null;
      disabled_by?: string | null;
      is_active?: boolean;
      must_change_password?: boolean;
      normalized_username: string;
      password_reset_operation_token?: string | null;
      password_reset_previous_must_change?: boolean | null;
      updated_at?: string;
      user_id: string;
      username: string;
    }>();
    expectTypeOf<Database["public"]["Tables"]["staff_accounts"]["Update"]>().toEqualTypeOf<{
      active_operation_desired?: boolean | null;
      active_operation_token?: string | null;
      active_state_version?: number;
      auth_identity_version?: number;
      created_at?: string;
      created_by?: string | null;
      disabled_at?: string | null;
      disabled_by?: string | null;
      is_active?: boolean;
      must_change_password?: boolean;
      normalized_username?: string;
      password_reset_operation_token?: string | null;
      password_reset_previous_must_change?: boolean | null;
      updated_at?: string;
      user_id?: string;
      username?: string;
    }>();

    expectTypeOf<Database["public"]["Tables"]["workbuddy_ingest_events"]["Row"]>().toEqualTypeOf<{
      client_created_at: string;
      created_at: string;
      event_id: string;
      payload_sha256: string;
      result: Json;
      session_id: string | null;
      source: string;
      student_id: string;
    }>();
    expectTypeOf<
      Database["public"]["Tables"]["workbuddy_ingest_events"]["Insert"]
    >().toEqualTypeOf<{
      client_created_at: string;
      created_at?: string;
      event_id: string;
      payload_sha256: string;
      result?: Json;
      session_id?: string | null;
      source: string;
      student_id: string;
    }>();
    expectTypeOf<
      Database["public"]["Tables"]["workbuddy_ingest_events"]["Update"]
    >().toEqualTypeOf<{
      client_created_at?: string;
      created_at?: string;
      event_id?: string;
      payload_sha256?: string;
      result?: Json;
      session_id?: string | null;
      source?: string;
      student_id?: string;
    }>();

    expectTypeOf<Database["public"]["Tables"]["workbuddy_credentials"]["Row"]>().toEqualTypeOf<{
      created_at: string;
      id: string;
      last_used_at: string | null;
      revoked_at: string | null;
      source: string;
      status: string;
      student_id: string;
      token_hash: string;
      token_prefix: string;
    }>();
    expectTypeOf<Database["public"]["Tables"]["workbuddy_credentials"]["Insert"]>().toEqualTypeOf<{
      created_at?: string;
      id?: string;
      last_used_at?: string | null;
      revoked_at?: string | null;
      source?: string;
      status?: string;
      student_id: string;
      token_hash: string;
      token_prefix: string;
    }>();
    expectTypeOf<Database["public"]["Tables"]["workbuddy_credentials"]["Update"]>().toEqualTypeOf<{
      created_at?: string;
      id?: string;
      last_used_at?: string | null;
      revoked_at?: string | null;
      source?: string;
      status?: string;
      student_id?: string;
      token_hash?: string;
      token_prefix?: string;
    }>();

    expectTypeOf<Database["public"]["Tables"]["mentor_message_deliveries"]["Row"]>().toEqualTypeOf<{
      acknowledged_at: string | null;
      created_at: string;
      failure_count: number;
      fetch_count: number;
      first_fetched_at: string | null;
      last_error_code: string | null;
      last_fetched_at: string | null;
      message_id: string;
      session_id: string;
      student_id: string;
      updated_at: string;
      web_seen_at: string | null;
    }>();
    expectTypeOf<
      Database["public"]["Tables"]["mentor_message_deliveries"]["Insert"]
    >().toEqualTypeOf<{
      acknowledged_at?: string | null;
      created_at?: string;
      failure_count?: number;
      fetch_count?: number;
      first_fetched_at?: string | null;
      last_error_code?: string | null;
      last_fetched_at?: string | null;
      message_id: string;
      session_id: string;
      student_id: string;
      updated_at?: string;
      web_seen_at?: string | null;
    }>();
    expectTypeOf<
      Database["public"]["Tables"]["mentor_message_deliveries"]["Update"]
    >().toEqualTypeOf<{
      acknowledged_at?: string | null;
      created_at?: string;
      failure_count?: number;
      fetch_count?: number;
      first_fetched_at?: string | null;
      last_error_code?: string | null;
      last_fetched_at?: string | null;
      message_id?: string;
      session_id?: string;
      student_id?: string;
      updated_at?: string;
      web_seen_at?: string | null;
    }>();

    expectTypeOf<
      Pick<Database["public"]["Tables"]["sessions"]["Row"], "source" | "source_session_key">
    >().toEqualTypeOf<{
      source: string;
      source_session_key: string | null;
    }>();
    expectTypeOf<
      Pick<Database["public"]["Tables"]["sessions"]["Insert"], "source" | "source_session_key">
    >().toEqualTypeOf<{
      source?: string;
      source_session_key?: string | null;
    }>();
    expectTypeOf<
      Pick<Database["public"]["Tables"]["sessions"]["Update"], "source" | "source_session_key">
    >().toEqualTypeOf<{
      source?: string;
      source_session_key?: string | null;
    }>();

    expectTypeOf<
      Pick<
        Database["public"]["Tables"]["timeline_items"]["Row"],
        "source_event_id" | "event_ordinal" | "author_username"
      >
    >().toEqualTypeOf<{
      author_username: string | null;
      event_ordinal: number | null;
      source_event_id: string | null;
    }>();
    expectTypeOf<
      Pick<
        Database["public"]["Tables"]["timeline_items"]["Insert"],
        "source_event_id" | "event_ordinal" | "author_username"
      >
    >().toEqualTypeOf<{
      author_username?: string | null;
      event_ordinal?: number | null;
      source_event_id?: string | null;
    }>();
    expectTypeOf<
      Pick<
        Database["public"]["Tables"]["timeline_items"]["Update"],
        "source_event_id" | "event_ordinal" | "author_username"
      >
    >().toEqualTypeOf<{
      author_username?: string | null;
      event_ordinal?: number | null;
      source_event_id?: string | null;
    }>();

    expectTypeOf<Database["public"]["Enums"]["app_role"]>().toEqualTypeOf<
      "mentor" | "student" | "team_admin"
    >();

    expectTypeOf<Database["public"]["Functions"]["has_active_role"]>().toEqualTypeOf<{
      Args: {
        _role: Database["public"]["Enums"]["app_role"];
        _user_id: string;
      };
      Returns: boolean;
    }>();
    expectTypeOf<Database["public"]["Functions"]["provision_staff_account"]>().toEqualTypeOf<{
      Args: {
        _auth_identity_version?: number;
        _created_by: string;
        _is_team_admin?: boolean;
        _user_id: string;
        _username: string;
      };
      Returns: Json;
    }>();
    expectTypeOf<Database["public"]["Functions"]["bootstrap_staff_account"]>().toEqualTypeOf<{
      Args: {
        _auth_identity_version?: number;
        _is_team_admin?: boolean;
        _user_id: string;
        _username: string;
      };
      Returns: Json;
    }>();
    expectTypeOf<Database["public"]["Functions"]["resolve_workbuddy_credential"]>().toEqualTypeOf<{
      Args: {
        _token_hash: string;
      };
      Returns: Json;
    }>();
    expectTypeOf<Database["public"]["Functions"]["ingest_workbuddy_turn"]>().toEqualTypeOf<{
      Args: {
        _client_created_at?: string | null;
        _diagnosis_severity?: Database["public"]["Enums"]["severity"] | null;
        _diagnosis_text?: string | null;
        _event_id: string;
        _payload_sha256: string;
        _prompt: string;
        _reply: string;
        _session_title: string;
        _source: string;
        _source_session_key: string;
        _student_id: string;
      };
      Returns: Json;
    }>();
    expectTypeOf<Database["public"]["Functions"]["create_mentor_message"]>().toEqualTypeOf<{
      Args: {
        _author_user_id: string;
        _session_id: string;
        _severity?: Database["public"]["Enums"]["severity"] | null;
        _text: string;
      };
      Returns: Json;
    }>();
    expectTypeOf<Database["public"]["Functions"]["create_ai_response"]>().toEqualTypeOf<{
      Args: {
        _actor_user_id: string;
        _diagnosis_severity: Database["public"]["Enums"]["severity"] | null;
        _diagnosis_text: string | null;
        _reply: string;
        _session_id: string;
        _tag: string | null;
      };
      Returns: Json;
    }>();
    expectTypeOf<
      Database["public"]["Functions"]["get_timeline_delivery_snapshot"]
    >().toEqualTypeOf<{
      Args: {
        _actor_user_id: string;
        _session_id: string;
      };
      Returns: Json;
    }>();
    expectTypeOf<Database["public"]["Functions"]["mark_mentor_messages_web_seen"]>().toEqualTypeOf<{
      Args: {
        _message_ids: string[];
      };
      Returns: number;
    }>();
    expectTypeOf<
      Database["public"]["Functions"]["fetch_workbuddy_mentor_messages"]
    >().toEqualTypeOf<{
      Args: {
        _cursor_created_at?: string | null;
        _cursor_id?: string | null;
        _limit?: number;
        _session_id?: string | null;
        _student_id: string;
      };
      Returns: Json;
    }>();
    expectTypeOf<Database["public"]["Functions"]["ack_workbuddy_mentor_messages"]>().toEqualTypeOf<{
      Args: {
        _message_ids: string[];
        _student_id: string;
      };
      Returns: Json;
    }>();
    expectTypeOf<
      Database["public"]["Functions"]["complete_staff_password_change"]
    >().toEqualTypeOf<{
      Args: { _user_id: string };
      Returns: boolean;
    }>();
  });

  test("isolates the team_admin enum change in its own migration", () => {
    expect(stripSqlComments(roleMigration)).toBe(
      "ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'team_admin';",
    );
    expect(cloudMigration).not.toMatch(/\bALTER\s+TYPE\s+public\.app_role\b/i);
  });

  test.each(Object.entries(newTableColumns))(
    "creates %s with exactly the foundation columns",
    (table, expectedColumns) => {
      expect(columnNames(createTableBody(cloudMigration, table))).toEqual(expectedColumns);
    },
  );

  test("defines staff identity lifecycle and audit constraints", () => {
    const table = createTableBody(cloudMigration, "staff_accounts");

    expectColumnDefinition(
      table,
      /\buser_id\s+uuid\s+PRIMARY KEY\s+REFERENCES\s+auth\.users\s*\(id\)\s+ON DELETE CASCADE/i,
    );
    expectColumnDefinition(table, /\bnormalized_username\s+text\s+NOT NULL\s+UNIQUE/i);
    expectColumnDefinition(table, /\bauth_identity_version\s+integer\s+NOT NULL\s+DEFAULT\s+1/i);
    expectColumnDefinition(table, /\bis_active\s+boolean\s+NOT NULL\s+DEFAULT\s+true/i);
    expectColumnDefinition(table, /\bmust_change_password\s+boolean\s+NOT NULL\s+DEFAULT\s+true/i);
    expect(table).toMatch(/\bCHECK\s*\(\s*auth_identity_version\s*=\s*1\s*\)/i);
    expect(table).toMatch(
      /\busername\s*=\s*normalized_username[\s\S]*?username\s*~\s*'\^\[a-z0-9\]\[a-z0-9\._-\]\{1,31\}\$'/i,
    );
    expect(table).toMatch(
      /\bnormalized_username\s*=\s*lower\s*\(\s*btrim\s*\(\s*normalized_username\s*\)\s*\)[\s\S]*?normalized_username\s*~\s*'\^\[a-z0-9\]\[a-z0-9\._-\]\{1,31\}\$'/i,
    );
    expect(cloudMigration).toMatch(
      /CREATE\s+INDEX\s+\w+\s+ON\s+public\.staff_accounts\s*\(\s*is_active\s*\)/i,
    );
  });

  test("adds bounded source identity to sessions with a partial uniqueness boundary", () => {
    expect(cloudMigration).toMatch(
      /ALTER\s+TABLE\s+public\.sessions[\s\S]*?ADD\s+COLUMN\s+source\s+text\s+NOT NULL\s+DEFAULT\s+'web'[\s\S]*?ADD\s+COLUMN\s+source_session_key\s+text/i,
    );
    expect(cloudMigration).toMatch(
      /CHECK\s*\(\s*source\s+IN\s*\(\s*'web'\s*,\s*'mcp'\s*,\s*'skill'\s*,\s*'connector'\s*\)\s*\)/i,
    );
    expect(cloudMigration).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+\w+\s+ON\s+public\.sessions\s*\(\s*student_id\s*,\s*source\s*,\s*source_session_key\s*\)\s+WHERE\s+source_session_key\s+IS\s+NOT\s+NULL/i,
    );
    expect(cloudMigration).toMatch(
      /source_session_key\s*=\s*btrim\s*\(\s*source_session_key\s*\)[\s\S]*?char_length\s*\(\s*source_session_key\s*\)\s+BETWEEN\s+1\s+AND\s+255/i,
    );
  });

  test("makes ingest events immutable identities with constrained sources and hashes", () => {
    const table = createTableBody(cloudMigration, "workbuddy_ingest_events");

    expectColumnDefinition(table, /\bevent_id\s+uuid\s+PRIMARY KEY\b/i);
    expectColumnDefinition(table, /\bresult\s+jsonb\s+NOT NULL\s+DEFAULT\s+'\{\}'::jsonb/i);
    expect(table).toMatch(
      /\bCHECK\s*\(\s*source\s+IN\s*\(\s*'mcp'\s*,\s*'skill'\s*,\s*'connector'\s*\)\s*\)/i,
    );
    expect(table).toMatch(/\bCHECK\s*\(\s*payload_sha256\s+~\s+'\^\[0-9a-f\]\{64\}\$'\s*\)/i);
  });

  test("links timeline items to deterministic event ordinals", () => {
    expect(cloudMigration).toMatch(
      /ALTER\s+TABLE\s+public\.timeline_items[\s\S]*?ADD\s+COLUMN\s+source_event_id\s+uuid[\s\S]*?ADD\s+COLUMN\s+event_ordinal\s+smallint[\s\S]*?ADD\s+COLUMN\s+author_username\s+text/i,
    );
    expect(cloudMigration).toMatch(/CHECK\s*\(\s*event_ordinal\s+BETWEEN\s+0\s+AND\s+2\s*\)/i);
    expect(cloudMigration).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+\w+\s+ON\s+public\.timeline_items\s*\(\s*source_event_id\s*,\s*event_ordinal\s*\)\s+WHERE\s+source_event_id\s+IS\s+NOT\s+NULL/i,
    );
  });

  test("stores only one-way WorkBuddy credential material", () => {
    const table = createTableBody(cloudMigration, "workbuddy_credentials");

    expect(columnNames(table)).not.toContain("token");
    expect(table).not.toMatch(/\bplaintext(?:_token)?\b/i);
    expectColumnDefinition(table, /\btoken_hash\s+text\s+NOT NULL\s+UNIQUE/i);
    expect(table).toMatch(/\bCHECK\s*\(\s*token_hash\s+~\s+'\^\[0-9a-f\]\{64\}\$'\s*\)/i);
    expect(table).toMatch(/\bCHECK\s*\(\s*status\s+IN\s*\(\s*'active'\s*,\s*'revoked'\s*\)/i);
    expectColumnDefinition(table, /\bsource\s+text\s+NOT NULL\s+DEFAULT\s+'issued'/i);
    expect(table).toMatch(
      /\bCHECK\s*\(\s*source\s+IN\s*\(\s*'issued'\s*,\s*'legacy_token_backfill'\s*\)/i,
    );
    expect(cloudMigration).toMatch(
      /INSERT\s+INTO\s+public\.workbuddy_credentials[\s\S]*?extensions\.digest\s*\(\s*student\.workbuddy_token\s*,\s*'sha256'\s*\)[\s\S]*?'legacy_token_backfill'[\s\S]*?FROM\s+public\.students[\s\S]*?ON\s+CONFLICT\s*\(\s*token_hash\s*\)\s+DO\s+NOTHING/i,
    );
    expect(cloudMigration).toMatch(
      /left\s*\(\s*encode\s*\(\s*extensions\.digest\s*\(\s*student\.workbuddy_token\s*,\s*'sha256'\s*\)\s*,\s*'hex'\s*\)\s*,\s*8\s*\)/i,
    );
    expect(cloudMigration).not.toMatch(/left\s*\(\s*student\.workbuddy_token\s*,/i);
  });

  test("tracks delivery fetch, acknowledgement, web visibility, and failures consistently", () => {
    const table = createTableBody(cloudMigration, "mentor_message_deliveries");

    expectColumnDefinition(table, /\bmessage_id\s+uuid\s+PRIMARY KEY\b/i);
    expect(table).toMatch(/\bCHECK\s*\(\s*fetch_count\s*>=\s*0\s*\)/i);
    expect(table).toMatch(/\bCHECK\s*\(\s*failure_count\s*>=\s*0\s*\)/i);
    expect(table).toMatch(
      /\bCHECK\s*\(\s*first_fetched_at\s+IS\s+NULL\s+OR\s+last_fetched_at\s+IS\s+NOT\s+NULL\s*\)/i,
    );
    expect(table).toMatch(
      /\bCHECK\s*\(\s*first_fetched_at\s+IS\s+NULL\s+OR\s+last_fetched_at\s*>=\s*first_fetched_at\s*\)/i,
    );
  });

  test("enables RLS and reserves direct access for the service role", () => {
    for (const table of Object.keys(newTableColumns)) {
      expect(cloudMigration).toMatch(
        new RegExp(
          `ALTER\\s+TABLE\\s+public\\.${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
          "i",
        ),
      );
      expect(cloudMigration).toMatch(
        new RegExp(`GRANT\\s+ALL\\s+ON\\s+TABLE\\s+public\\.${table}\\s+TO\\s+service_role`, "i"),
      );
      expect(cloudMigration).toMatch(
        new RegExp(
          `REVOKE\\s+ALL\\s+ON\\s+TABLE\\s+public\\.${table}\\s+FROM\\s+PUBLIC\\s*,\\s*anon`,
          "i",
        ),
      );
    }

    expect(cloudMigration).not.toMatch(
      /GRANT\s+[^;]*\btoken_hash\b[^;]*\bTO\s+(?:authenticated|anon|PUBLIC)\b/i,
    );
  });

  test("adds realtime tables only when publication membership is absent", () => {
    expect(cloudMigration).toMatch(/\bDO\s+\$publication\$/i);
    expect(cloudMigration).toMatch(/\bFROM\s+pg_publication_tables\b/i);
    expect(cloudMigration).not.toMatch(/\bDROP\s+PUBLICATION\b/i);

    for (const table of [
      "staff_accounts",
      "workbuddy_ingest_events",
      "mentor_message_deliveries",
    ]) {
      expect(cloudMigration).toMatch(
        new RegExp(
          `NOT\\s+EXISTS[\\s\\S]*?tablename\\s*=\\s*'${table}'[\\s\\S]*?ALTER\\s+PUBLICATION\\s+supabase_realtime\\s+ADD\\s+TABLE\\s+public\\.${table}`,
          "i",
        ),
      );
    }
  });

  test("hardens every cloud function with an empty search path and least privilege", () => {
    const securityDefinerFunctions = [
      "has_active_role",
      "handle_new_user",
      "prepare_mentor_timeline_item",
      "validate_mentor_delivery",
      "create_mentor_delivery",
      "prevent_delivered_mentor_kind_change",
      "on_timeline_insert",
      "mark_mentor_messages_web_seen",
      "get_my_legacy_workbuddy_setup",
    ];
    const serviceInvokerFunctions = [
      "bootstrap_staff_account",
      "provision_staff_account",
      "complete_staff_password_change",
      "resolve_workbuddy_credential",
      "ingest_workbuddy_turn",
      "create_mentor_message",
    ];

    for (const functionName of [...securityDefinerFunctions, ...serviceInvokerFunctions]) {
      expect(functionDefinition(cloudMigration, functionName)).toMatch(
        /\bSET\s+search_path\s*=\s*''/i,
      );
      expectRevokedFromClients(functionName);
    }

    for (const functionName of securityDefinerFunctions) {
      expect(functionDefinition(cloudMigration, functionName)).toMatch(/\bSECURITY\s+DEFINER\b/i);
    }

    for (const functionName of serviceInvokerFunctions) {
      expect(functionDefinition(cloudMigration, functionName)).toMatch(/\bSECURITY\s+INVOKER\b/i);
    }

    expect(cloudMigration).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.has_active_role\s*\([^;]*\)\s+TO\s+authenticated\s*,\s*service_role/i,
    );
    expect(cloudMigration).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.mark_mentor_messages_web_seen\s*\([^;]*\)\s+TO\s+authenticated/i,
    );
    expect(cloudMigration).toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.complete_staff_password_change\s*\(\s*uuid\s*\)\s+TO\s+service_role/i,
    );
    expect(cloudMigration).not.toMatch(
      /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.complete_staff_password_change\s*\([^;]*\)\s+TO\s+(?:anon|authenticated)/i,
    );

    for (const functionName of serviceInvokerFunctions) {
      expect(cloudMigration).toMatch(
        new RegExp(
          `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${functionName}\\s*\\([^;]*\\)\\s+TO\\s+service_role`,
          "i",
        ),
      );
      expect(cloudMigration).not.toMatch(
        new RegExp(
          `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${functionName}\\s*\\([^;]*\\)\\s+TO\\s+(?:anon|authenticated)`,
          "i",
        ),
      );
    }
  });

  test("gates staff roles on an active account with a completed password change", () => {
    const helper = functionDefinition(cloudMigration, "has_active_role");

    expect(helper).toMatch(/\bFROM\s+public\.user_roles\b/i);
    expect(helper).toMatch(/\b_role\s*=\s*'student'::public\.app_role\b/i);
    expect(helper).toMatch(/\bJOIN\s+public\.staff_accounts\b/i);
    expect(helper).toMatch(/\bis_active\s*=\s*true\b/i);
    expect(helper).toMatch(/\bmust_change_password\s*=\s*false\b/i);
    expect(helper).toMatch(/\b_role\s+IN\s*\([^)]*'mentor'[^)]*'team_admin'[^)]*\)/i);
  });

  test("prevents signup metadata from promoting a public user", () => {
    const handler = functionDefinition(staffAuthCompatibilityMigration, "handle_new_user");

    expect(handler).toMatch(
      /raw_app_meta_data\s*->>\s*'account_kind'\s*=\s*'staff'[\s\S]*?RETURN\s+NEW/i,
    );
    expect(handler).toMatch(
      /NEW\.email\s*~\s*'\^u1_\[A-Za-z0-9_-\]\{43\}@auth\\\.copilot\\\.sg\\\.superbrain-ai\\\.com\$'[\s\S]*?RETURN\s+NEW/,
    );
    expect(handler).not.toMatch(/raw_user_meta_data\s*->>\s*'role'/i);
    expect(handler).toMatch(
      /INSERT\s+INTO\s+public\.user_roles[\s\S]*?'student'::public\.app_role/i,
    );
    expect(handler).toMatch(/INSERT\s+INTO\s+public\.students\b/i);
  });

  test("provisions a validated staff identity without accepting an arbitrary role", () => {
    const provisioner = functionDefinition(cloudMigration, "provision_staff_account");
    const signature = provisioner.slice(0, provisioner.search(/\bRETURNS\b/i));

    expect(signature).toMatch(/\b_user_id\s+uuid\b/i);
    expect(signature).toMatch(/\b_username\s+text\b/i);
    expect(signature).toMatch(/\b_auth_identity_version\s+integer\b/i);
    expect(signature).toMatch(/\b_created_by\s+uuid\b(?!\s+DEFAULT)/i);
    expect(signature).toMatch(/\b_is_team_admin\s+boolean\b/i);
    expect(signature).not.toMatch(/\b_role\s+public\.app_role\b/i);
    expect(provisioner).toMatch(
      /\b_username\s+IS\s+DISTINCT\s+FROM\s+pg_catalog\.lower\s*\(\s*pg_catalog\.btrim\s*\(\s*_username\s*\)\s*\)/i,
    );
    expect(provisioner).toMatch(/\b_username\s*!~\s*'\^\[a-z0-9\]\[a-z0-9\._-\]\{1,31\}\$'/i);
    expect(provisioner).toMatch(/\b_auth_identity_version\s*<>\s*1\b/i);
    expect(provisioner).toMatch(
      /actor\.user_id\s*=\s*_created_by[\s\S]*?actor\.is_active\s*=\s*true[\s\S]*?actor\.must_change_password\s*=\s*false[\s\S]*?'team_admin'::public\.app_role/i,
    );
    expect(cloudMigration).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.bootstrap_staff_account[\s\S]*?REVOKE\s+ALL[\s\S]*?GRANT\s+EXECUTE[\s\S]*?TO\s+service_role/i,
    );
    expect(provisioner).not.toMatch(/derived_normalized_username\s*:=\s*pg_catalog\.lower/i);
    expect(provisioner).toMatch(
      /INSERT\s+INTO\s+public\.staff_accounts[\s\S]*?normalized_username/i,
    );
    expect(provisioner).toMatch(
      /INSERT\s+INTO\s+public\.user_roles[\s\S]*?'mentor'::public\.app_role/i,
    );
    expect(provisioner).toMatch(
      /IF\s+_is_team_admin[\s\S]*?INSERT\s+INTO\s+public\.user_roles[\s\S]*?'team_admin'::public\.app_role/i,
    );
  });

  test("allows only the service role to complete an explicit active staff password change", () => {
    const completion = functionDefinition(cloudMigration, "complete_staff_password_change");
    const signature = completion.slice(0, completion.search(/\bRETURNS\b/i));

    expect(signature).toMatch(/complete_staff_password_change\s*\(\s*_user_id\s+uuid\s*\)/i);
    expect(completion).toMatch(/\bSECURITY\s+INVOKER\b/i);
    expect(completion).toMatch(
      /UPDATE\s+public\.staff_accounts[\s\S]*?must_change_password\s*=\s*false[\s\S]*?user_id\s*=\s*_user_id[\s\S]*?is_active\s*=\s*true/i,
    );
    expect(completion).not.toMatch(/\bauth\.uid\s*\(/i);
    expectRevokedFromClients("complete_staff_password_change");
  });

  test("ingests a turn through an event-first idempotency boundary", () => {
    const ingest = functionDefinition(cloudMigration, "ingest_workbuddy_turn");
    const eventInsert = ingest.search(/INSERT\s+INTO\s+public\.workbuddy_ingest_events\b/i);
    const sessionInsert = ingest.search(/INSERT\s+INTO\s+public\.sessions\b/i);

    for (const parameter of [
      "_event_id uuid",
      "_student_id uuid",
      "_source text",
      "_source_session_key text",
      "_session_title text",
      "_payload_sha256 text",
      "_prompt text",
      "_reply text",
      "_diagnosis_text text",
      "_diagnosis_severity public.severity",
      "_client_created_at timestamptz",
    ]) {
      expect(ingest.toLowerCase()).toContain(parameter);
    }

    expect(eventInsert).toBeGreaterThanOrEqual(0);
    expect(sessionInsert).toBeGreaterThan(eventInsert);
    expect(ingest).toMatch(
      /INSERT\s+INTO\s+public\.workbuddy_ingest_events[\s\S]*?ON\s+CONFLICT\s*\(\s*event_id\s*\)\s+DO\s+NOTHING/i,
    );
    expect(ingest).toMatch(
      /payload_sha256[\s\S]*?<>\s*_payload_sha256[\s\S]*?ERRCODE\s*=\s*'P4090'[\s\S]*?MESSAGE\s*=\s*'workbuddy_event_conflict'/i,
    );
    expect(ingest).toMatch(/jsonb_build_object\s*\(\s*'duplicate'\s*,\s*true\s*\)/i);
    expect(ingest).toMatch(
      /\b_source\s+NOT\s+IN\s*\(\s*'mcp'\s*,\s*'skill'\s*,\s*'connector'\s*\)/i,
    );
    expect(ingest).toMatch(/\b_diagnosis_severity\s+IS\s+NOT\s+NULL\b/i);
  });

  test("resolves sessions only by student, source, and source key without title heuristics", () => {
    const ingest = functionDefinition(cloudMigration, "ingest_workbuddy_turn");

    expect(ingest).toMatch(
      /INSERT\s+INTO\s+public\.sessions[\s\S]*?ON\s+CONFLICT\s*\(\s*student_id\s*,\s*source\s*,\s*source_session_key\s*\)\s+WHERE\s+source_session_key\s+IS\s+NOT\s+NULL\s+DO\s+UPDATE/i,
    );
    expect(ingest).not.toMatch(/\bWHERE\s+session_title\s*=/i);
    expect(ingest).not.toMatch(/\bORDER\s+BY\s+(?:created_at|updated_at)\b/i);
  });

  test("writes deterministic timeline ordinals and persists stable item ids", () => {
    const ingest = functionDefinition(cloudMigration, "ingest_workbuddy_turn");

    expect(ingest).toMatch(
      /INSERT\s+INTO\s+public\.timeline_items[\s\S]*?'prompt'::public\.timeline_kind[\s\S]*?0/i,
    );
    expect(ingest).toMatch(
      /INSERT\s+INTO\s+public\.timeline_items[\s\S]*?'reply'::public\.timeline_kind[\s\S]*?1/i,
    );
    expect(ingest).toMatch(
      /INSERT\s+INTO\s+public\.timeline_items[\s\S]*?'diagnosis'::public\.timeline_kind[\s\S]*?2/i,
    );

    for (const resultKey of [
      "session_id",
      "prompt_item_id",
      "reply_item_id",
      "diagnosis_item_id",
    ]) {
      expect(ingest).toMatch(new RegExp(`'${resultKey}'\\s*,`, "i"));
    }

    expect(ingest).toMatch(
      /UPDATE\s+public\.workbuddy_ingest_events[\s\S]*?SET\s+session_id\s*=[\s\S]*?result\s*=/i,
    );
  });

  test("creates mentor messages through one trigger-owned identity and delivery path", () => {
    const creator = functionDefinition(mentorSendMigration, "create_mentor_message");
    const signature = creator.slice(0, creator.search(/\bRETURNS\b/i));
    const timelineInsert = creator.search(/INSERT\s+INTO\s+public\.timeline_items\b/i);

    expect(signature).not.toMatch(/author_username/i);
    expect(signature).not.toMatch(/_student_id/i);
    expect(creator).toMatch(
      /FROM\s+public\.staff_accounts[\s\S]*?staff\.user_id\s*=\s*_author_user_id[\s\S]*?staff\.is_active\s*=\s*true[\s\S]*?staff\.must_change_password\s*=\s*false/i,
    );
    expect(creator).toMatch(
      /staff_role\.role\s+IN\s*\([\s\S]*?'mentor'::public\.app_role[\s\S]*?'team_admin'::public\.app_role/i,
    );
    expect(creator).toMatch(/FROM\s+public\.sessions[\s\S]*?session_row\.id\s*=\s*_session_id/i);
    expect(timelineInsert).toBeGreaterThanOrEqual(0);
    expect(creator).not.toMatch(/INSERT\s+INTO\s+public\.mentor_message_deliveries\b/i);
    expect(cloudMigration).toMatch(
      /CREATE\s+TRIGGER\s+\w+[\s\S]*?BEFORE\s+INSERT[\s\S]*?ON\s+public\.timeline_items[\s\S]*?EXECUTE\s+FUNCTION\s+public\.prepare_mentor_timeline_item\s*\(\s*\)/i,
    );
    expect(cloudMigration).toMatch(
      /CREATE\s+TRIGGER\s+\w+[\s\S]*?AFTER\s+INSERT[\s\S]*?ON\s+public\.timeline_items[\s\S]*?EXECUTE\s+FUNCTION\s+public\.create_mentor_delivery\s*\(\s*\)/i,
    );
    const preparer = functionDefinition(cloudMigration, "prepare_mentor_timeline_item");
    const deliveryTrigger = functionDefinition(cloudMigration, "create_mentor_delivery");
    expect(preparer).toMatch(/NEW\.author_username\s*:=\s*staff(?:_account)?\.username/i);
    expect(preparer).toMatch(/\bNEW\.source_event_id\s+IS\s+NOT\s+NULL\b/i);
    expect(preparer).toMatch(/\bNEW\.event_ordinal\s+IS\s+NOT\s+NULL\b/i);
    expect(preparer).toMatch(/\bNEW\.kind\s*<>\s*'mentor'::public\.timeline_kind\b/i);
    expect(deliveryTrigger).toMatch(
      /INSERT\s+INTO\s+public\.mentor_message_deliveries[\s\S]*?NEW\.id[\s\S]*?target_session\.student_id[\s\S]*?NEW\.session_id/i,
    );
    expect(creator).toMatch(/'delivery_state'\s*,\s*'pending'/i);
  });

  test("persists AI reply and diagnosis atomically through a service-only student boundary", () => {
    const creator = functionDefinition(mentorSendMigration, "create_ai_response");
    expect(creator).toMatch(
      /FROM\s+public\.students[\s\S]*?student\.user_id\s*=\s*_actor_user_id/i,
    );
    expect(creator).toMatch(
      /FROM\s+public\.sessions[\s\S]*?target_session\.student_id\s*=\s*actor_student_id/i,
    );
    expect(creator.match(/INSERT\s+INTO\s+public\.timeline_items/gi)).toHaveLength(2);
    expect(creator).toMatch(/'reply'::public\.timeline_kind/);
    expect(creator).toMatch(/'diagnosis'::public\.timeline_kind/);
    expect(mentorSendMigration).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.create_ai_response[\s\S]*?authenticated[\s\S]*?GRANT\s+EXECUTE[\s\S]*?service_role/i,
    );
  });

  test("returns timeline and delivery through one service-only left-joined snapshot", () => {
    const snapshot = functionDefinition(mentorSendMigration, "get_timeline_delivery_snapshot");
    expect(snapshot).toMatch(
      /FROM\s+public\.timeline_items[\s\S]*?LEFT\s+JOIN\s+public\.mentor_message_deliveries/i,
    );
    expect(snapshot).toMatch(/_actor_user_id/);
    expect(mentorSendMigration).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.get_timeline_delivery_snapshot[\s\S]*?authenticated[\s\S]*?GRANT\s+EXECUTE[\s\S]*?service_role/i,
    );
  });

  test("hardens the legacy timeline aggregate trigger after client UPDATE revocation", () => {
    const aggregateTrigger = functionDefinition(cloudMigration, "on_timeline_insert");

    expect(aggregateTrigger).toMatch(/\bSECURITY\s+DEFINER\b/i);
    expect(aggregateTrigger).toMatch(/\bSET\s+search_path\s*=\s*''/i);
    expect(aggregateTrigger).toMatch(
      /UPDATE\s+public\.sessions[\s\S]*?updated_at\s*=\s*pg_catalog\.now\s*\(\s*\)[\s\S]*?last_severity\s*=\s*COALESCE\s*\(\s*NEW\.severity\s*,\s*last_severity\s*\)[\s\S]*?WHERE\s+id\s*=\s*NEW\.session_id/i,
    );
    expect(aggregateTrigger).toMatch(
      /UPDATE\s+public\.students[\s\S]*?last_active_at\s*=\s*pg_catalog\.now\s*\(\s*\)[\s\S]*?last_severity\s*=\s*COALESCE\s*\(\s*NEW\.severity\s*,\s*last_severity\s*\)[\s\S]*?public\.sessions[\s\S]*?NEW\.session_id/i,
    );
    expect(cloudMigration).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.on_timeline_insert\s*\(\s*\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated/i,
    );
  });

  test("limits web-seen updates to the authenticated student's owned messages", () => {
    const marker = functionDefinition(cloudMigration, "mark_mentor_messages_web_seen");

    expect(marker).toMatch(
      /UPDATE\s+public\.mentor_message_deliveries[\s\S]*?SET\s+web_seen_at\s*=/i,
    );
    expect(marker).toMatch(/JOIN\s+public\.students[\s\S]*?user_id\s*=\s*auth\.uid\s*\(\s*\)/i);
    expect(marker).toMatch(/\bmessage_id\s*=\s*ANY\s*\(\s*_message_ids\s*\)/i);
    expect(marker).not.toMatch(
      /\b(?:first_fetched_at|last_fetched_at|fetch_count|acknowledged_at|failure_count|last_error_code)\s*=/i,
    );
  });

  test("replaces legacy policies and table-wide grants with provenance-safe client writes", () => {
    for (const legacyPolicy of [
      "students read own or mentor",
      "students mentor manage",
      "sessions read own or mentor",
      "sessions owner insert",
      "sessions owner update",
      "sessions owner delete",
      "timeline read own or mentor",
      "timeline student insert own session",
      "timeline mentor insert",
      "timeline author delete",
    ]) {
      expect(cloudMigration).toMatch(
        new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+"${legacyPolicy}"`, "i"),
      );
    }

    for (const table of ["students", "sessions", "timeline_items"]) {
      expect(cloudMigration).toMatch(
        new RegExp(
          `CREATE\\s+POLICY\\s+[^;]+\\s+ON\\s+public\\.${table}[\\s\\S]*?public\\.has_active_role\\s*\\([^;]+?'mentor'[\\s\\S]*?public\\.has_active_role\\s*\\([^;]+?'team_admin'`,
          "i",
        ),
      );
    }

    expect(cloudMigration).not.toMatch(
      /CREATE\s+POLICY\s+[^;]+\s+ON\s+public\.(?:students|sessions|timeline_items)[^;]*private\.has_role/i,
    );

    expect(cloudMigration).toMatch(
      /REVOKE\s+(?:ALL|INSERT\s*,\s*UPDATE\s*,\s*DELETE)[^;]*ON\s+TABLE\s+public\.sessions\s+FROM\s+authenticated/i,
    );
    expect(cloudMigration).toMatch(
      /GRANT\s+INSERT\s*\(\s*student_id\s*,\s*session_title\s*,\s*session_group\s*,\s*last_severity\s*\)\s+ON\s+public\.sessions\s+TO\s+authenticated/i,
    );
    expect(cloudMigration).toMatch(
      /CREATE\s+POLICY\s+"sessions owner insert web only"[\s\S]*?source\s*=\s*'web'[\s\S]*?source_session_key\s+IS\s+NULL/i,
    );
    expect(cloudMigration).toMatch(
      /CREATE\s+POLICY\s+"sessions owner update web only"[\s\S]*?USING[\s\S]*?source\s*=\s*'web'[\s\S]*?WITH\s+CHECK[\s\S]*?source_session_key\s+IS\s+NULL/i,
    );
    expect(cloudMigration).toMatch(
      /REVOKE\s+(?:ALL|INSERT\s*,\s*UPDATE\s*,\s*DELETE)[^;]*ON\s+TABLE\s+public\.timeline_items\s+FROM\s+authenticated/i,
    );
    expect(cloudMigration).toMatch(
      /GRANT\s+INSERT\s*\(\s*session_id\s*,\s*kind\s*,\s*text\s*,\s*severity\s*,\s*tag\s*,\s*author_id\s*\)\s+ON\s+public\.timeline_items\s+TO\s+authenticated/i,
    );
    expect(cloudMigration).toMatch(
      /CREATE\s+POLICY\s+"timeline student insert without provenance"[\s\S]*?source_event_id\s+IS\s+NULL[\s\S]*?event_ordinal\s+IS\s+NULL[\s\S]*?author_username\s+IS\s+NULL/i,
    );
    expect(cloudMigration).toMatch(
      /CREATE\s+POLICY\s+"timeline active staff mentor insert"[\s\S]*?kind\s*=\s*'mentor'::public\.timeline_kind[\s\S]*?source_event_id\s+IS\s+NULL[\s\S]*?event_ordinal\s+IS\s+NULL[\s\S]*?has_active_role/i,
    );

    expect(cloudMigration).toMatch(
      /CREATE\s+POLICY\s+[^;]+\s+ON\s+public\.staff_accounts\s+FOR\s+SELECT[\s\S]*?user_id\s*=\s*auth\.uid\s*\(\s*\)[\s\S]*?has_active_role[\s\S]*?'team_admin'/i,
    );
    expect(cloudMigration).toMatch(
      /CREATE\s+POLICY\s+[^;]+\s+ON\s+public\.workbuddy_ingest_events\s+FOR\s+SELECT[\s\S]*?student[\s\S]*?auth\.uid\s*\(\s*\)[\s\S]*?has_active_role/i,
    );
    expect(cloudMigration).toMatch(
      /CREATE\s+POLICY\s+[^;]+\s+ON\s+public\.mentor_message_deliveries\s+FOR\s+SELECT[\s\S]*?student[\s\S]*?auth\.uid\s*\(\s*\)[\s\S]*?has_active_role/i,
    );

    for (const table of [
      "staff_accounts",
      "workbuddy_ingest_events",
      "mentor_message_deliveries",
    ]) {
      expect(cloudMigration).toMatch(
        new RegExp(
          `GRANT\\s+SELECT\\s+ON\\s+TABLE\\s+public\\.${table}\\s+TO\\s+authenticated`,
          "i",
        ),
      );
      expect(cloudMigration).not.toMatch(
        new RegExp(
          `GRANT\\s+(?:INSERT|UPDATE|DELETE|ALL)[^;]*ON\\s+TABLE\\s+public\\.${table}\\s+TO\\s+authenticated`,
          "i",
        ),
      );
    }

    expect(cloudMigration).not.toMatch(
      /GRANT\s+SELECT\s+ON\s+TABLE\s+public\.workbuddy_credentials\s+TO\s+authenticated/i,
    );
    expect(cloudMigration).not.toMatch(
      /GRANT\s+[^;]*\bDELETE\b[^;]*\bTO\s+(?:authenticated|anon|PUBLIC)\b/i,
    );
  });

  test("removes the temporary plaintext transition after callers migrate", () => {
    expect(cloudMigration).toMatch(
      /REVOKE\s+SELECT\s*,\s*INSERT\s*,\s*UPDATE\s*,\s*DELETE\s+ON\s+TABLE\s+public\.students\s+FROM\s+authenticated/i,
    );
    expect(cloudMigration).toMatch(
      /GRANT\s+SELECT\s*\(\s*id\s*,\s*user_id\s*,\s*display_name\s*,\s*last_severity\s*,\s*last_active_at\s*,\s*created_at\s*,\s*updated_at\s*\)\s+ON\s+public\.students\s+TO\s+authenticated/i,
    );
    expect(cloudMigration).not.toMatch(
      /GRANT\s+SELECT\s*\([^)]*\bworkbuddy_token\b[^)]*\)\s+ON\s+public\.students\s+TO\s+authenticated/i,
    );

    expect(deliveryMigration).toMatch(
      /DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.get_my_legacy_workbuddy_setup\s*\(\s*\)/i,
    );
    expect(deliveryMigration).toMatch(
      /ALTER\s+TABLE\s+public\.students[\s\S]*?DROP\s+COLUMN\s+IF\s+EXISTS\s+workbuddy_token/i,
    );
    expect(generatedTypes).not.toMatch(/\bworkbuddy_token\b/i);
    expect(generatedTypes).not.toMatch(/\bget_my_legacy_workbuddy_setup\b/i);
  });

  test("stages existing staff only from trusted explicit metadata then aborts unresolved roles", () => {
    const stagingStart = cloudMigration.indexOf("INSERT INTO public.staff_accounts");
    const stagingEnd = cloudMigration.indexOf("DO $existing_staff_guard$");
    const staging = cloudMigration.slice(stagingStart, stagingEnd);

    expect(stagingStart).toBeGreaterThanOrEqual(0);
    expect(stagingEnd).toBeGreaterThan(stagingStart);
    expect(staging).toMatch(
      /INSERT\s+INTO\s+public\.staff_accounts[\s\S]*?auth\.users[\s\S]*?raw_app_meta_data\s*->>\s*'account_kind'\s*=\s*'staff'[\s\S]*?raw_app_meta_data\s*->>\s*'staff_username'/i,
    );
    expect(staging).not.toMatch(
      /INSERT\s+INTO\s+public\.staff_accounts[\s\S]*?(?:split_part\s*\(\s*\w+\.email|raw_user_meta_data)/i,
    );
    expect(cloudMigration).toMatch(
      /RAISE\s+EXCEPTION\s+USING[\s\S]*?ERRCODE\s*=\s*'PST01'[\s\S]*?MESSAGE\s*=\s*'unresolved_staff_accounts'/i,
    );
  });

  test("enforces student, session, event, message, and mentor-kind consistency", () => {
    for (const contract of [
      /UNIQUE\s*\(\s*id\s*,\s*student_id\s*\)/i,
      /FOREIGN\s+KEY\s*\(\s*session_id\s*,\s*student_id\s*\)\s+REFERENCES\s+public\.sessions\s*\(\s*id\s*,\s*student_id\s*\)/i,
      /UNIQUE\s*\(\s*event_id\s*,\s*session_id\s*\)/i,
      /FOREIGN\s+KEY\s*\(\s*source_event_id\s*,\s*session_id\s*\)\s+REFERENCES\s+public\.workbuddy_ingest_events\s*\(\s*event_id\s*,\s*session_id\s*\)/i,
      /UNIQUE\s*\(\s*id\s*,\s*session_id\s*\)/i,
      /FOREIGN\s+KEY\s*\(\s*message_id\s*,\s*session_id\s*\)\s+REFERENCES\s+public\.timeline_items\s*\(\s*id\s*,\s*session_id\s*\)/i,
      /FOREIGN\s+KEY\s*\(\s*session_id\s*,\s*student_id\s*\)\s+REFERENCES\s+public\.sessions\s*\(\s*id\s*,\s*student_id\s*\)/i,
    ]) {
      expect(cloudMigration).toMatch(contract);
    }

    const validator = functionDefinition(cloudMigration, "validate_mentor_delivery");
    expect(validator).toMatch(/timeline_item\.kind\s*<>\s*'mentor'::public\.timeline_kind/i);
    expect(validator).toMatch(/\bFOR\s+UPDATE\b/i);
    expect(validator).toMatch(
      /pg_catalog\.pg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtextextended\s*\(\s*NEW\.message_id::text\s*,\s*0\s*\)\s*\)/i,
    );
    expect(validator).toMatch(/MESSAGE\s*=\s*'mentor_delivery_message_kind_required'/i);

    const kindGuard = functionDefinition(cloudMigration, "prevent_delivered_mentor_kind_change");
    expect(kindGuard).toMatch(/\bSECURITY\s+DEFINER\b/i);
    expect(kindGuard).toMatch(/\bNEW\.kind\s+IS\s+DISTINCT\s+FROM\s+OLD\.kind\b/i);
    expect(kindGuard).toMatch(
      /EXISTS[\s\S]*?FROM\s+public\.mentor_message_deliveries[\s\S]*?message_id\s*=\s*OLD\.id/i,
    );
    expect(kindGuard).toMatch(
      /pg_catalog\.pg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtextextended\s*\(\s*OLD\.id::text\s*,\s*0\s*\)\s*\)/i,
    );
    expect(kindGuard).toMatch(/MESSAGE\s*=\s*'delivered_mentor_kind_immutable'/i);
    expect(cloudMigration).toMatch(
      /CREATE\s+TRIGGER\s+\w+[\s\S]*?BEFORE\s+UPDATE\s+OF\s+kind\s+ON\s+public\.timeline_items[\s\S]*?EXECUTE\s+FUNCTION\s+public\.prevent_delivered_mentor_kind_change\s*\(\s*\)/i,
    );
  });

  test("gates obsolete private.has_role and leaves no policy on the unsafe helper", () => {
    expect(cloudMigration).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+private\.has_role[\s\S]*?SET\s+search_path\s*=\s*''[\s\S]*?public\.has_active_role\s*\(\s*_user_id\s*,\s*_role\s*\)/i,
    );
    expect(cloudMigration).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+private\.has_role\s*\(\s*uuid\s*,\s*public\.app_role\s*\)\s+FROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated/i,
    );
    expect(cloudMigration).not.toMatch(/CREATE\s+POLICY\s+[^;]+private\.has_role/i);
  });

  test("covers service execution, hostile provenance, staff states, and cross-row mismatches in pgTAP", () => {
    expect(pgTap).toMatch(/\bSET\s+LOCAL\s+ROLE\s+service_role\b/i);
    expect(pgTap).toMatch(/\bSET\s+LOCAL\s+ROLE\s+authenticated\b/i);
    expect(pgTap).toMatch(/disabled staff cannot insert a mentor message/i);
    expect(pgTap).toMatch(/staff awaiting password change cannot insert a mentor message/i);
    expect(pgTap).toMatch(/student cannot supply a source session key/i);
    expect(pgTap).toMatch(/student cannot forge timeline provenance/i);
    expect(pgTap).toMatch(/active staff direct insert derives username and delivery/i);
    expect(pgTap).toMatch(/student direct timeline insert updates session and student aggregates/i);
    expect(pgTap).toMatch(/active staff direct insert updates session and student aggregates/i);
    expect(pgTap).toMatch(/mentor delivery rejects a non-mentor timeline item/i);
    expect(pgTap).toMatch(/delivered mentor timeline kind is immutable/i);
    expect(pgTap).toMatch(/removes the legacy plaintext student credential column/i);
    expect(pgTap).toMatch(/composite cursor retains messages that share an identical timestamp/i);
    expect(pgTap).toMatch(/mixed acknowledgement failure makes no partial update/i);
    expect(pgTap).toMatch(/event rejects a session owned by another student/i);
    expect(pgTap).toMatch(/timeline rejects a session that differs from its event/i);
    expect(pgTap).toMatch(/delivery rejects a session mismatched to its message/i);
    expect(pgTap).toMatch(/delivery rejects a student mismatched to its session/i);
    expect(pgTap).toMatch(/delivery identity columns are immutable/i);
    expect(pgTap).toMatch(/authenticated browsers cannot read credential status directly/i);
  });

  test("defines an explicit-env two-client concurrency integration test", () => {
    expect(concurrencyTest).toMatch(/createClient<Database>/);
    expect(concurrencyTest.match(/createClient<Database>/g)).toHaveLength(8);
    expect(concurrencyTest).toMatch(/Promise\.all\s*\(/);
    expect(concurrencyTest).toMatch(/CONCURRENCY_ROUNDS\s*=\s*[3-9]/);
    expect(concurrencyTest).toMatch(/launchTogether/);
    expect(concurrencyTest).toMatch(/count:\s*"exact"/);
    expect(concurrencyTest).toMatch(/CONCURRENCY_ROUNDS\s*\*\s*2/);
    expect(concurrencyTest).toMatch(/CLOUD_INTEGRATION_TEST_URL/);
    expect(concurrencyTest).toMatch(/CLOUD_INTEGRATION_SERVICE_ROLE_KEY/);
    expect(concurrencyTest).toMatch(/CLOUD_INTEGRATION_TEST_STUDENT_ID/);
    expect(concurrencyTest).toMatch(/CLOUD_INTEGRATION_TEST_ALLOW_WRITES/);
    expect(concurrencyTest).toMatch(/skipIf\s*\(/);
    expect(concurrencyTest).toMatch(/duplicate/);
    expect(concurrencyTest).toMatch(/P4090/);
    expect(concurrencyTest).toMatch(/issue_workbuddy_credential/);
    expect(concurrencyTest).toMatch(/workbuddy_credentials/);
    expect(concurrencyTest).toMatch(/active\.count\)\.toBe\(1\)/);
    expect(concurrencyTest).toMatch(/fetch_workbuddy_mentor_messages/);
    expect(concurrencyTest).toMatch(/ack_workbuddy_mentor_messages/);
    expect(concurrencyTest).toMatch(/Earlier created_at, higher UUID/);
    expect(concurrencyTest).toMatch(/Later created_at, lower UUID/);
    expect(concurrencyTest).toMatch(/fetch racing a timeline cascade delete/);
    expect(concurrencyTest).toMatch(/from\("timeline_items"\)\.delete\(\)\.eq\("id", messageId\)/);
  });

  test("restricts student realtime payloads to the four UI fields", () => {
    expect(mentorDesk).toMatch(
      /\.channel\s*\(\s*"students-rt"\s*\)[\s\S]*?\.on\s*\(\s*"postgres_changes"\s*,\s*\{[\s\S]*?event:\s*"\*"[\s\S]*?schema:\s*"public"[\s\S]*?table:\s*"students"[\s\S]*?select:\s*\[\s*"id"\s*,\s*"display_name"\s*,\s*"last_severity"\s*,\s*"last_active_at"\s*\]/i,
    );
    expect(mentorDesk).not.toMatch(
      /\.channel\s*\(\s*"students-rt"\s*\)[\s\S]*?select:\s*\[[^\]]*\bworkbuddy_token\b/i,
    );
  });

  test("keeps generated RPC types aligned with the migration signatures", () => {
    for (const functionName of [
      "has_active_role",
      "bootstrap_staff_account",
      "provision_staff_account",
      "complete_staff_password_change",
      "ingest_workbuddy_turn",
      "create_mentor_message",
      "mark_mentor_messages_web_seen",
      "fetch_workbuddy_mentor_messages",
      "ack_workbuddy_mentor_messages",
      "get_workbuddy_credential_status",
      "issue_workbuddy_credential",
      "revoke_workbuddy_credential",
    ]) {
      expect(generatedTypes).toMatch(new RegExp(`\\b${functionName}:\\s*\\{`, "i"));
    }

    expect(generatedTypes).toMatch(
      /ingest_workbuddy_turn:\s*\{[\s\S]*?_source_session_key:\s*string[\s\S]*?Returns:\s*Json/i,
    );
    expect(generatedTypes).toMatch(
      /ingest_workbuddy_turn:\s*\{[\s\S]*?_diagnosis_severity\?:\s*Database\["public"\]\["Enums"\]\["severity"\]\s*\|\s*null/i,
    );
    expect(generatedTypes).toMatch(
      /create_mentor_message:\s*\{[\s\S]*?_author_user_id:\s*string[\s\S]*?Returns:\s*Json/i,
    );
    expect(generatedTypes).toMatch(
      /mark_mentor_messages_web_seen:\s*\{[\s\S]*?_message_ids:\s*string\[\][\s\S]*?Returns:\s*number/i,
    );
    expect(generatedTypes).toMatch(
      /complete_staff_password_change:\s*\{[\s\S]*?Args:\s*\{\s*_user_id:\s*string\s*;\s*\}\s*;[\s\S]*?Returns:\s*boolean/i,
    );
  });

  test("keeps pgTAP coverage for canonical staff identities and trusted password completion", () => {
    expect(pgTap).toMatch(/SELECT\s+plan\s*\(\s*126\s*\)/i);
    expect(pgTap).toMatch(/rejects uppercase staff usernames/i);
    expect(pgTap).toMatch(/rejects fullwidth staff usernames/i);
    expect(pgTap).toMatch(/rejects out-of-range staff usernames/i);
    expect(pgTap).toMatch(/service mentor creation accepts exactly 8000 Unicode characters/i);
    expect(pgTap).toMatch(/disabled staff cannot create mentor messages/i);
    expect(pgTap).toMatch(/password-change-required staff cannot create mentor messages/i);
    expect(pgTap).toMatch(/a failed delivery insert rolls back the mentor timeline item/i);
    expect(pgTap).toMatch(/student browser cannot call the service-only mentor message RPC/i);
    expect(pgTap).toMatch(/student browser cannot call the service-only AI response RPC/i);
    expect(pgTap).toMatch(/a failed diagnosis rolls back the AI reply/i);
    expect(pgTap).toMatch(/student browser cannot call the service-only timeline snapshot RPC/i);
    expect(pgTap).toMatch(/student snapshot cannot read another student session/i);
    expect(pgTap).toMatch(/authenticated mentor insert rejects 8001 Unicode characters/i);
    expect(pgTap).toMatch(/service role cannot insert delivery rows directly/i);
    expect(pgTap).toMatch(/service role cannot update delivery rows directly/i);
    expect(pgTap).toMatch(/rejects unsupported auth identity versions/i);
    expect(pgTap).toMatch(/authenticated browser cannot complete a staff password change/i);
    expect(pgTap).toMatch(/password completion updates only the explicit active staff row/i);
    expect(pgTap).toMatch(/password completion is idempotent for retry/i);
    expect(pgTap).toMatch(/service role cannot complete a student password change/i);
    expect(pgTap).toMatch(/service role cannot complete a disabled staff password change/i);
  });

  test("does not contain destructive data operations", () => {
    expect(cloudMigration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(cloudMigration).not.toMatch(/\bTRUNCATE\b/i);
    expect(staffAuthCompatibilityMigration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(staffAuthCompatibilityMigration).not.toMatch(/\bTRUNCATE\b/i);
  });
});
