import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

import type { Database } from "../../../src/integrations/supabase/types";
import { mentorUsernameToEmail } from "../../../src/lib/auth/identifiers";

const requiredEnvironment = [
  "E2E_SUPABASE_URL",
  "E2E_SUPABASE_ANON_KEY",
  "E2E_SUPABASE_SERVICE_ROLE_KEY",
  "E2E_TEST_PASSWORD",
  "E2E_TEST_NEW_PASSWORD",
] as const;

const missingEnvironment = requiredEnvironment.filter((name) => !process.env[name]);
const requiredRun = process.env.E2E_REQUIRED === "1";

if (requiredRun && missingEnvironment.length > 0) {
  throw new Error(`Required E2E configuration is missing: ${missingEnvironment.join(", ")}`);
}

export const E2E_ENVIRONMENT = {
  available: missingEnvironment.length === 0,
  skipReason:
    missingEnvironment.length === 0
      ? undefined
      : `local Supabase E2E environment is unavailable (${missingEnvironment.join(", ")})`,
} as const;

type StaffFixture = {
  userId: string;
  username: string;
};

type StudentFixture = {
  userId: string;
  studentId: string;
  displayName: string;
  email: string;
  token: string;
};

type PublicJsonResponse = {
  status: number;
  body: Record<string, unknown>;
};

function requireValue(name: (typeof requiredEnvironment)[number]): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required E2E configuration is missing: ${name}`);
  return value;
}

function adminClient(): SupabaseClient<Database> {
  return createClient<Database>(
    requireValue("E2E_SUPABASE_URL"),
    requireValue("E2E_SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

function assertNoError(error: { message: string } | null, operation: string): void {
  if (error) throw new Error(`E2E fixture ${operation} failed`);
}

async function findAuthUserByEmail(
  client: SupabaseClient<Database>,
  email: string,
): Promise<User | null> {
  for (let page = 1; page <= 100; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    assertNoError(error, "auth lookup");
    const match = data.users.find((user) => user.email === email);
    if (match) return match;
    if (data.users.length < 200) return null;
  }
  throw new Error("E2E fixture auth lookup exceeded its page limit");
}

export async function loginWithPassword(
  page: Page,
  identifier: string,
  password: string,
): Promise<void> {
  await page.goto("/auth");
  await page.getByLabel("用户名或学员邮箱").fill(identifier);
  await page.getByLabel("密码").fill(password);
  await page.locator("form").getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL((url) => url.pathname !== "/auth");
}

export type E2EHarness = {
  readonly initialPassword: string;
  readonly newPassword: string;
  uniqueEmail(prefix: string): string;
  uniqueLabel(prefix: string): string;
  uniqueUsername(prefix: string): string;
  trackEmail(email: string): void;
  trackMentorUsername(username: string): void;
  createStaff(input: {
    prefix: string;
    mustChangePassword: boolean;
    teamAdmin: boolean;
  }): Promise<StaffFixture>;
  createStudent(prefix: string): Promise<StudentFixture>;
  createStudentSession(
    student: StudentFixture,
    input: { title: string; prompt: string },
  ): Promise<{ sessionId: string; title: string; prompt: string }>;
  trackStaffByUsername(username: string): Promise<StaffFixture>;
  readStudentIdentity(email: string): Promise<{ displayName: string; roles: string[] } | null>;
  readStaffState(
    userId: string,
  ): Promise<{ active: boolean; mustChangePassword: boolean; roles: string[] }>;
  timelineContains(sessionId: string, text: string): Promise<boolean>;
  readTimelineItemId(sessionId: string, text: string): Promise<string>;
  publicJson(
    path: string,
    input: { method: "GET" | "POST"; token: string; body?: unknown },
  ): Promise<PublicJsonResponse>;
  readDelivery(messageId: string): Promise<{
    fetchCount: number;
    acknowledged: boolean;
    studentId: string;
    sessionId: string;
  }>;
  cleanup(): Promise<void>;
};

export async function createE2EHarness(): Promise<E2EHarness> {
  if (!E2E_ENVIRONMENT.available) {
    throw new Error("E2E fixture cannot start without a local Supabase environment");
  }

  const client = adminClient();
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const trackedUserIds = new Set<string>();
  const trackedEmails = new Set<string>();
  const appOrigin =
    process.env.E2E_APP_ORIGIN ?? `http://127.0.0.1:${Number(process.env.E2E_APP_PORT ?? 3411)}`;
  const initialPassword = requireValue("E2E_TEST_PASSWORD");
  const newPassword = requireValue("E2E_TEST_NEW_PASSWORD");

  const uniqueUsername = (prefix: string): string =>
    `${prefix
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 16)}${runId}`.slice(0, 32);
  const uniqueLabel = (prefix: string): string => `${prefix}-${runId}`;
  const uniqueEmail = (prefix: string): string => {
    const prefixHash = createHash("sha256").update(prefix, "utf8").digest("hex").slice(0, 10);
    return `e2e.${prefixHash}.${runId}@example.com`;
  };

  async function createStaff(input: {
    prefix: string;
    mustChangePassword: boolean;
    teamAdmin: boolean;
  }): Promise<StaffFixture> {
    const username = uniqueUsername(input.prefix);
    const email = mentorUsernameToEmail(username);
    const created = await client.auth.admin.createUser({
      email,
      password: initialPassword,
      email_confirm: true,
      user_metadata: { username },
      app_metadata: {
        account_kind: "staff",
        staff_username: username,
        auth_identity_version: 1,
      },
    });
    assertNoError(created.error, "staff auth creation");
    if (!created.data.user) throw new Error("E2E fixture staff auth creation returned no user");
    trackedUserIds.add(created.data.user.id);

    const provisioned = await client.rpc("bootstrap_staff_account", {
      _user_id: created.data.user.id,
      _username: username,
      _auth_identity_version: 1,
      _is_team_admin: input.teamAdmin,
    });
    assertNoError(provisioned.error, "staff database provisioning");

    if (!input.mustChangePassword) {
      const completed = await client
        .from("staff_accounts")
        .update({ must_change_password: false })
        .eq("user_id", created.data.user.id)
        .eq("is_active", true);
      assertNoError(completed.error, "staff password-state completion");
    }

    return { userId: created.data.user.id, username };
  }

  async function createStudent(prefix: string): Promise<StudentFixture> {
    const displayName = uniqueLabel(prefix);
    const email = uniqueEmail(prefix);
    const created = await client.auth.admin.createUser({
      email,
      password: initialPassword,
      email_confirm: true,
      user_metadata: {
        display_name: displayName,
        role: "student",
      },
    });
    assertNoError(created.error, "student auth creation");
    if (!created.data.user) throw new Error("E2E fixture student auth creation returned no user");
    trackedUserIds.add(created.data.user.id);

    const student = await client
      .from("students")
      .select("id")
      .eq("user_id", created.data.user.id)
      .single();
    assertNoError(student.error, "student profile lookup");
    if (!student.data) throw new Error("E2E fixture student profile lookup returned no row");

    const token = `wb_${randomBytes(32).toString("base64url")}`;
    const issued = await client.rpc("issue_workbuddy_credential", {
      _user_id: created.data.user.id,
      _token_hash: createHash("sha256").update(token, "utf8").digest("hex"),
      _token_prefix: token.slice(0, 11),
      _rotate: false,
    });
    assertNoError(issued.error, "student credential issue");

    return {
      userId: created.data.user.id,
      studentId: student.data.id,
      displayName,
      email,
      token,
    };
  }

  async function createStudentSession(
    student: StudentFixture,
    input: { title: string; prompt: string },
  ) {
    const session = await client
      .from("sessions")
      .insert({
        student_id: student.studentId,
        session_title: input.title,
        session_group: "task",
        source: "web",
      })
      .select("id")
      .single();
    assertNoError(session.error, "student session creation");
    if (!session.data) throw new Error("E2E fixture student session creation returned no row");

    const timeline = await client.from("timeline_items").insert({
      session_id: session.data.id,
      kind: "prompt",
      text: input.prompt,
      author_id: student.userId,
    });
    assertNoError(timeline.error, "student prompt creation");

    return {
      sessionId: session.data.id,
      title: input.title,
      prompt: input.prompt,
    };
  }

  async function trackStaffByUsername(username: string): Promise<StaffFixture> {
    const staff = await client
      .from("staff_accounts")
      .select("user_id, username")
      .eq("normalized_username", username)
      .single();
    assertNoError(staff.error, "managed staff lookup");
    if (!staff.data) throw new Error("E2E fixture managed staff lookup returned no row");
    trackedUserIds.add(staff.data.user_id);
    return { userId: staff.data.user_id, username: staff.data.username };
  }

  async function readStudentIdentity(email: string) {
    const user = await findAuthUserByEmail(client, email);
    if (!user) return null;
    trackedUserIds.add(user.id);

    const [student, roles] = await Promise.all([
      client.from("students").select("display_name").eq("user_id", user.id).maybeSingle(),
      client.from("user_roles").select("role").eq("user_id", user.id),
    ]);
    assertNoError(student.error, "student identity lookup");
    assertNoError(roles.error, "student role lookup");
    if (!student.data) return null;
    return {
      displayName: student.data.display_name,
      roles: (roles.data ?? []).map(({ role }) => role).sort(),
    };
  }

  async function readStaffState(userId: string) {
    const [staff, roles] = await Promise.all([
      client
        .from("staff_accounts")
        .select("is_active, must_change_password")
        .eq("user_id", userId)
        .single(),
      client
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .in("role", ["mentor", "team_admin"]),
    ]);
    assertNoError(staff.error, "staff state lookup");
    assertNoError(roles.error, "staff role lookup");
    if (!staff.data) throw new Error("E2E fixture staff state lookup returned no row");
    return {
      active: staff.data.is_active,
      mustChangePassword: staff.data.must_change_password,
      roles: (roles.data ?? []).map(({ role }) => role).sort(),
    };
  }

  async function timelineContains(sessionId: string, text: string): Promise<boolean> {
    const result = await client
      .from("timeline_items")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("text", text);
    assertNoError(result.error, "timeline content lookup");
    return result.count === 1;
  }

  async function readTimelineItemId(sessionId: string, text: string): Promise<string> {
    const result = await client
      .from("timeline_items")
      .select("id")
      .eq("session_id", sessionId)
      .eq("kind", "mentor")
      .eq("text", text)
      .single();
    assertNoError(result.error, "timeline item lookup");
    if (!result.data) throw new Error("E2E fixture timeline item lookup returned no row");
    return result.data.id;
  }

  async function publicJson(
    path: string,
    input: { method: "GET" | "POST"; token: string; body?: unknown },
  ): Promise<PublicJsonResponse> {
    const response = await fetch(new URL(path, appOrigin), {
      method: input.method,
      headers: {
        Authorization: `Bearer ${input.token}`,
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new Error(`E2E public API returned non-JSON status=${response.status}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`E2E public API returned invalid JSON status=${response.status}`);
    }
    return {
      status: response.status,
      body: parsed as Record<string, unknown>,
    };
  }

  async function readDelivery(messageId: string) {
    const delivery = await client
      .from("mentor_message_deliveries")
      .select("fetch_count, acknowledged_at, student_id, session_id")
      .eq("message_id", messageId)
      .single();
    assertNoError(delivery.error, "delivery lookup");
    if (!delivery.data) throw new Error("E2E fixture delivery lookup returned no row");
    return {
      fetchCount: delivery.data.fetch_count,
      acknowledged: delivery.data.acknowledged_at !== null,
      studentId: delivery.data.student_id,
      sessionId: delivery.data.session_id,
    };
  }

  async function cleanup(): Promise<void> {
    for (const email of trackedEmails) {
      const user = await findAuthUserByEmail(client, email);
      if (user) trackedUserIds.add(user.id);
    }

    let cleanupFailures = 0;
    for (const userId of trackedUserIds) {
      const { error } = await client.auth.admin.deleteUser(userId);
      if (error) cleanupFailures += 1;
    }
    if (cleanupFailures > 0) {
      throw new Error(`E2E fixture cleanup failed for ${cleanupFailures} test user(s)`);
    }
  }

  return {
    initialPassword,
    newPassword,
    uniqueEmail,
    uniqueLabel,
    uniqueUsername,
    trackEmail(email) {
      trackedEmails.add(email);
    },
    trackMentorUsername(username) {
      trackedEmails.add(mentorUsernameToEmail(username));
    },
    createStaff,
    createStudent,
    createStudentSession,
    trackStaffByUsername,
    readStudentIdentity,
    readStaffState,
    timelineContains,
    readTimelineItemId,
    publicJson,
    readDelivery,
    cleanup,
  };
}
