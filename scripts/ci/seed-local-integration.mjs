import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createClient } from "@supabase/supabase-js";

const destination = process.argv[2] || process.env.GITHUB_ENV;
const url = process.env.E2E_SUPABASE_URL;
const serviceRoleKey = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
const password = process.env.E2E_TEST_PASSWORD;
if (!destination || !url || !serviceRoleKey || !password) {
  throw new Error("Local integration seed requires GITHUB_ENV and E2E Supabase configuration");
}
if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(url)) {
  throw new Error("Local integration seed refuses a non-local Supabase URL");
}

const client = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);

const student = await client.auth.admin.createUser({
  email: `ci.concurrency.${suffix}@example.com`,
  password,
  email_confirm: true,
  user_metadata: {
    display_name: `CI concurrency ${suffix}`,
    role: "student",
  },
});
if (student.error || !student.data.user) {
  throw new Error("Local integration student seed failed");
}
const studentProfile = await client
  .from("students")
  .select("id")
  .eq("user_id", student.data.user.id)
  .single();
if (studentProfile.error || !studentProfile.data) {
  throw new Error("Local integration student profile seed failed");
}

const username = `cimentor${suffix}`.slice(0, 32);
const staff = await client.auth.admin.createUser({
  email: `ci.staff.${suffix}@example.com`,
  password,
  email_confirm: true,
  user_metadata: { username },
  app_metadata: {
    account_kind: "staff",
    staff_username: username,
    auth_identity_version: 1,
  },
});
if (staff.error || !staff.data.user) {
  throw new Error("Local integration staff auth seed failed");
}
const provisioned = await client.rpc("bootstrap_staff_account", {
  _user_id: staff.data.user.id,
  _username: username,
  _auth_identity_version: 1,
  _is_team_admin: false,
});
if (provisioned.error) throw new Error("Local integration staff database seed failed");
const completed = await client
  .from("staff_accounts")
  .update({ must_change_password: false })
  .eq("user_id", staff.data.user.id);
if (completed.error) throw new Error("Local integration staff activation seed failed");

await appendFile(
  resolve(destination),
  `CLOUD_INTEGRATION_TEST_STUDENT_ID=${studentProfile.data.id}\nCLOUD_INTEGRATION_TEST_ALLOW_WRITES=true\n`,
  { encoding: "utf8", mode: 0o600 },
);
process.stdout.write("Ephemeral integration identities seeded without printing credentials.\n");
