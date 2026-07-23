import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260723090300_reliable_delivery.sql"),
  "utf8",
);
const credentialFunctions = readFileSync(
  resolve(process.cwd(), "src/lib/workbuddy/credentials.functions.ts"),
  "utf8",
);
const setupPage = readFileSync(
  resolve(process.cwd(), "src/routes/_authenticated/workbuddy.tsx"),
  "utf8",
);
const mentorDesk = readFileSync(
  resolve(process.cwd(), "src/routes/_authenticated/index.tsx"),
  "utf8",
);
const deliveryService = readFileSync(
  resolve(process.cwd(), "src/lib/workbuddy/delivery.server.ts"),
  "utf8",
);
const mcpMentorReply = readFileSync(
  resolve(process.cwd(), "src/lib/mcp/tools/reply-as-mentor.ts"),
  "utf8",
);
const cloudMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260723090100_cloud_integration.sql"),
  "utf8",
);

function sqlFunction(name: string): string {
  const start = migration.search(
    new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`, "i"),
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const next = migration.indexOf("CREATE OR REPLACE FUNCTION public.", start + 40);
  return migration.slice(start, next < 0 ? migration.length : next);
}

describe("Task 6 database safety contracts", () => {
  test("removes the legacy plaintext credential surface after migrating every caller", () => {
    expect(migration).toMatch(
      /DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.get_my_legacy_workbuddy_setup\s*\(\s*\)/i,
    );
    expect(migration).toMatch(
      /ALTER\s+TABLE\s+public\.students\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+workbuddy_token/i,
    );
    expect(migration).not.toMatch(/SELECT[\s\S]*students\.workbuddy_token/i);
    const dropPlaintext = migration.search(
      /ALTER\s+TABLE\s+public\.students\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+workbuddy_token/i,
    );
    const restoreSafeStudentRead = migration.search(
      /GRANT\s+SELECT\s+ON\s+TABLE\s+public\.students\s+TO\s+authenticated/i,
    );
    expect(restoreSafeStudentRead).toBeGreaterThan(dropPlaintext);
    expect(credentialFunctions).not.toMatch(/workbuddy_token/i);
    expect(setupPage).not.toMatch(/workbuddy_token|localStorage|sessionStorage/i);
  });

  test("enforces one active credential per student at the database boundary", () => {
    expect(migration).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+workbuddy_credentials_one_active_per_student[\s\S]*?\(\s*student_id\s*\)[\s\S]*?WHERE\s+status\s*=\s*'active'/i,
    );
    const issue = sqlFunction("issue_workbuddy_credential");
    expect(issue).toMatch(/pg_advisory_xact_lock/i);
    expect(issue).toMatch(/_rotate/i);
    expect(issue).toMatch(
      /UPDATE\s+public\.workbuddy_credentials[\s\S]*?status\s*=\s*'revoked'[\s\S]*?INSERT\s+INTO\s+public\.workbuddy_credentials/i,
    );
    expect(issue).not.toMatch(/jsonb_build_object\s*\([^)]*'token_hash'/i);
  });

  test("fetch owns ordering, ownership, mentor-kind, and first timestamp invariants", () => {
    const fetch = sqlFunction("fetch_workbuddy_mentor_messages");
    expect(fetch).toMatch(/delivery\.student_id\s*=\s*_student_id/i);
    expect(fetch).toMatch(/target_session\.student_id\s*=\s*_student_id/i);
    expect(fetch).toMatch(/item\.kind\s*=\s*'mentor'/i);
    expect(fetch).toMatch(/delivery\.acknowledged_at\s+IS\s+NULL/i);
    expect(fetch).toMatch(
      /\(\s*item\.created_at\s*,\s*item\.id\s*\)\s*>\s*\(\s*_cursor_created_at\s*,\s*_cursor_id\s*\)/i,
    );
    expect(fetch).toMatch(/ORDER\s+BY\s+item\.created_at\s*,\s*item\.id/i);
    expect(fetch).toMatch(
      /first_fetched_at\s*=\s*COALESCE\s*\(\s*delivery\.first_fetched_at\s*,\s*pg_catalog\.now\(\)\s*\)/i,
    );
    expect(fetch).toMatch(/fetch_count\s*=\s*delivery\.fetch_count\s*\+\s*1/i);
  });

  test("ack validates the complete set before its atomic idempotent update", () => {
    const ack = sqlFunction("ack_workbuddy_mentor_messages");
    const ownershipCheck = ack.search(/workbuddy_delivery_not_owned/i);
    const update = ack.search(/UPDATE\s+public\.mentor_message_deliveries/i);
    expect(ownershipCheck).toBeGreaterThanOrEqual(0);
    expect(update).toBeGreaterThan(ownershipCheck);
    expect(ack).toMatch(/student_id\s*=\s*_student_id/i);
    expect(ack).toMatch(
      /acknowledged_at\s*=\s*COALESCE\s*\(\s*delivery\.acknowledged_at\s*,\s*pg_catalog\.now\(\)\s*\)/i,
    );
  });

  test("all delivery and management RPCs are service-role-only", () => {
    for (const name of [
      "fetch_workbuddy_mentor_messages",
      "ack_workbuddy_mentor_messages",
      "get_workbuddy_credential_status",
      "issue_workbuddy_credential",
      "revoke_workbuddy_credential",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${name}\\s*\\([\\s\\S]*?FROM\\s+PUBLIC\\s*,\\s*anon\\s*,\\s*authenticated`,
          "i",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${name}\\s*\\([\\s\\S]*?TO\\s+service_role`,
          "i",
        ),
      );
    }
  });

  test("serializes every delivery insert/update path with one student-scoped lock", () => {
    expect(migration).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+private\.lock_workbuddy_delivery_student\s*\(\s*_student_id\s+uuid\s*\)[\s\S]*?pg_advisory_xact_lock[\s\S]*?workbuddy-delivery-student:/i,
    );

    for (const name of [
      "fetch_workbuddy_mentor_messages",
      "ack_workbuddy_mentor_messages",
      "mark_mentor_messages_web_seen",
      "create_mentor_delivery",
      "validate_mentor_delivery",
    ]) {
      const definition = sqlFunction(name);
      const studentLock = definition.search(/private\.lock_workbuddy_delivery_student/i);
      const firstRowLockOrWrite = definition.search(
        /FOR\s+UPDATE|(?:INSERT\s+INTO|UPDATE)\s+public\.mentor_message_deliveries/i,
      );
      expect(studentLock, `${name} must take the student lock`).toBeGreaterThanOrEqual(0);
      expect(
        firstRowLockOrWrite,
        `${name} must take the student lock before row locks/writes`,
      ).toBeGreaterThan(studentLock);
    }

    expect(cloudMigration).toMatch(
      /CREATE\s+TRIGGER\s+validate_mentor_delivery_before_write[\s\S]*?BEFORE\s+INSERT\s+OR\s+UPDATE\s+ON\s+public\.mentor_message_deliveries[\s\S]*?public\.validate_mentor_delivery/i,
    );
    expect(migration).toMatch(
      /REVOKE\s+ALL\s+ON\s+TABLE\s+public\.mentor_message_deliveries\s+FROM\s+service_role[\s\S]*?GRANT\s+SELECT\s+ON\s+TABLE\s+public\.mentor_message_deliveries\s+TO\s+service_role/i,
    );
    for (const name of ["fetch_workbuddy_mentor_messages", "ack_workbuddy_mentor_messages"]) {
      expect(sqlFunction(name)).toMatch(/\bSECURITY\s+DEFINER\b/i);
    }
  });

  test("rejects delivery identity updates and bypasses parent locks for state-only updates", () => {
    const validator = sqlFunction("validate_mentor_delivery");
    const updateStart = validator.search(/IF\s+TG_OP\s*=\s*'UPDATE'\s+THEN/i);
    const insertLock = validator.search(/PERFORM\s+private\.lock_workbuddy_delivery_student/i);
    const timelineLock = validator.search(
      /SELECT\s+item\.\*[\s\S]*?FROM\s+public\.timeline_items[\s\S]*?FOR\s+UPDATE/i,
    );
    const updateBranch = validator.slice(updateStart, insertLock);

    expect(updateStart).toBeGreaterThanOrEqual(0);
    expect(insertLock).toBeGreaterThan(updateStart);
    expect(timelineLock).toBeGreaterThan(insertLock);
    for (const column of ["message_id", "student_id", "session_id"]) {
      expect(updateBranch).toMatch(
        new RegExp(`OLD\\.${column}\\s+IS\\s+DISTINCT\\s+FROM\\s+NEW\\.${column}`, "i"),
      );
    }
    expect(updateBranch).toMatch(/mentor_delivery_identity_immutable/i);
    expect(updateBranch).toMatch(/RETURN\s+NEW\s*;\s*END\s+IF\s*;\s*$/i);
    expect(updateBranch).not.toMatch(
      /timeline_items|FOR\s+UPDATE|lock_workbuddy_delivery_student/i,
    );
    expect(cloudMigration).toMatch(
      /CREATE\s+TRIGGER\s+validate_mentor_delivery_before_write[\s\S]*?BEFORE\s+INSERT\s+OR\s+UPDATE\s+ON\s+public\.mentor_message_deliveries[\s\S]*?public\.validate_mentor_delivery/i,
    );
  });

  test("keeps parent cascade deletes outside the delivery advisory-lock cycle", () => {
    const fetch = sqlFunction("fetch_workbuddy_mentor_messages");
    const candidateLock = fetch.match(/FOR\s+UPDATE(?:\s+OF\s+[^;\n,)]+)?/gi) ?? [];

    expect(candidateLock).toContain("FOR UPDATE OF delivery");
    expect(candidateLock).not.toContain("FOR UPDATE");
    expect(fetch).not.toMatch(
      /FOR\s+(?:UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\s+OF\s+(?:item|target_session)/i,
    );

    for (const table of ["students", "sessions", "timeline_items"]) {
      expect(cloudMigration).toMatch(
        new RegExp(
          `REVOKE[\\s\\S]{0,80}DELETE[\\s\\S]{0,80}ON\\s+TABLE\\s+public\\.${table}[\\s\\S]{0,40}FROM\\s+authenticated`,
          "i",
        ),
      );
    }
  });

  test("enforces one shared 8000-character mentor-message boundary", () => {
    expect(migration).toMatch(
      /ADD\s+CONSTRAINT\s+timeline_items_mentor_text_length_check[\s\S]*?kind\s*<>\s*'mentor'[\s\S]*?char_length\s*\(\s*text\s*\)\s+BETWEEN\s+1\s+AND\s+8000/i,
    );
    for (const name of [
      "prepare_mentor_timeline_item",
      "create_mentor_message",
      "fetch_workbuddy_mentor_messages",
    ]) {
      expect(sqlFunction(name)).toMatch(/char_length[\s\S]*?8_?000|8_?000[\s\S]*?char_length/i);
    }
    expect(deliveryService).toMatch(
      /text:\s*z\.string\(\)\.refine\(\s*isMentorMessageWithinLimit\s*\)/,
    );
    expect(mentorDesk).toMatch(/MENTOR_MESSAGE_INPUT_MAX_CODE_UNITS/);
    expect(mentorDesk).toMatch(
      /maxLength=\{\s*isStudent\s*\?\s*2_000\s*:\s*MENTOR_MESSAGE_INPUT_MAX_CODE_UNITS\s*\}/,
    );
    expect(mentorDesk).not.toMatch(/maxLength=\{\s*isStudent\s*\?\s*2_000\s*:\s*16_?000\s*\}/);
    const sendMentor = mentorDesk.slice(
      mentorDesk.indexOf("const sendMentor"),
      mentorDesk.indexOf("const sendStudentPrompt"),
    );
    expect(sendMentor).toMatch(
      /const\s+text\s*=\s*composeText\.trim\(\)[\s\S]*?isMentorMessageWithinLimit\(\s*text\s*\)/,
    );
    expect(mentorDesk).toMatch(
      /mentorMessageTooLong\s*=[\s\S]*?!isMentorMessageWithinLimit\(\s*mentorSubmissionText\s*\)/,
    );
    expect(mentorDesk).toMatch(/disabled=\{[^}]*mentorMessageTooLong[^}]*\}/);
    expect(mentorDesk).toMatch(/字符[\s\S]*?8000|8000[\s\S]*?字符/);
    expect(mcpMentorReply).toMatch(/\.refine\(\s*isMentorMessageWithinLimit\s*\)/);
  });

  test("server functions derive the caller and accept no student ID or secret material", () => {
    expect(credentialFunctions).toMatch(/requireSupabaseAuth/);
    expect(credentialFunctions).toMatch(/context\.userId/);
    expect(credentialFunctions).not.toMatch(/studentId|tokenHash|token_hash/);
    expect(credentialFunctions).toMatch(/createWorkbuddyCredential/);
    expect(credentialFunctions).toMatch(/rotateWorkbuddyCredential/);
    expect(credentialFunctions).toMatch(/revokeWorkbuddyCredential/);
  });

  test("credential page requires issuance before install and keeps one-time clear controls", () => {
    expect(setupPage).toMatch(/createWorkbuddyCredential|rotateWorkbuddyCredential/);
    expect(setupPage).toMatch(/revokeWorkbuddyCredential/);
    expect(setupPage).toMatch(/仅显示这一次|刷新.*无法恢复|离开.*无法恢复/);
    expect(setupPage).toMatch(/清除|clear/i);
    expect(setupPage).toMatch(/navigator\.clipboard/);
    expect(setupPage).not.toMatch(/console\.(?:log|info|debug)\s*\(/);
  });
});
