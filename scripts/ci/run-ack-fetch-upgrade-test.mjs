import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();
const config = await readFile(resolve(root, "supabase/config.toml"), "utf8");
const projectId = config.match(/^project_id\s*=\s*"([a-z0-9]+)"\s*$/m)?.[1];
if (!projectId) throw new Error("Supabase project_id is missing or invalid");
if (process.env.DOCKER_HOST) {
  throw new Error("Upgrade test refuses an explicit Docker host");
}

async function dockerOutput(args) {
  const child = spawn("docker", args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (exitCode !== 0) throw new Error("Unable to verify the local Docker target");
  return stdout.trim();
}

const dockerEndpoint = await dockerOutput([
  "context",
  "inspect",
  "--format",
  "{{.Endpoints.docker.Host}}",
]);
if (!dockerEndpoint.startsWith("unix://")) {
  throw new Error("Upgrade test refuses a remote Docker context");
}

const container = `supabase_db_${projectId}`;
const containerIdentity = await dockerOutput([
  "inspect",
  "--format",
  '{{index .Config.Labels "com.supabase.cli.project"}}|{{.State.Running}}',
  container,
]);
if (containerIdentity !== `${projectId}|true`) {
  throw new Error("Upgrade test requires the running local Supabase database");
}

const [fixture, migration] = await Promise.all([
  readFile(resolve(root, "tests/integration/sql/ack-fetch-upgrade.sql"), "utf8"),
  readFile(
    resolve(root, "supabase/migrations/20260724010000_require_fetch_before_ack.sql"),
    "utf8",
  ),
]);
const marker = "-- __ACK_FETCH_GUARD_MIGRATION__";
if (fixture.split(marker).length !== 2) {
  throw new Error("Upgrade fixture must contain exactly one migration marker");
}

const cleanupSql = `
RESET ROLE;
BEGIN;

LOCK TABLE public.mentor_message_deliveries IN ACCESS EXCLUSIVE MODE;

DELETE FROM auth.users
WHERE id IN (
  '91000000-0000-0000-0000-000000000001'::uuid,
  '91000000-0000-0000-0000-000000000101'::uuid
);

UPDATE public.mentor_message_deliveries
SET acknowledged_at = NULL
WHERE acknowledged_at IS NOT NULL
  AND first_fetched_at IS NULL;

DO $cleanup$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.mentor_message_deliveries'::regclass
      AND constraint_row.conname =
        'mentor_message_deliveries_ack_requires_fetch_check'
  ) THEN
    ALTER TABLE public.mentor_message_deliveries
      ADD CONSTRAINT mentor_message_deliveries_ack_requires_fetch_check
      CHECK (
        acknowledged_at IS NULL
        OR first_fetched_at IS NOT NULL
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.mentor_message_deliveries'::regclass
      AND constraint_row.conname =
        'mentor_message_deliveries_ack_requires_fetch_check'
      AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'ACK fetch cleanup did not restore the validated constraint';
  END IF;
END;
$cleanup$;

COMMIT;
`;

async function runPsql(sql) {
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end(sql);

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  return { exitCode, stdout, stderr };
}

async function cleanupDatabase() {
  const result = await runPsql(cleanupSql);
  if (result.exitCode !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`ACK fetch cleanup failed with exit code ${result.exitCode}`);
  }
}

async function runFixture(sql) {
  try {
    return await runPsql(sql);
  } finally {
    await cleanupDatabase();
  }
}

const negativeControlMigration = migration.replace(
  /\nCOMMIT;\s*$/i,
  "\nSELECT 1 FROM public.__ack_fetch_negative_control_missing;\n\nCOMMIT;\n",
);
if (negativeControlMigration === migration) {
  throw new Error("ACK fetch negative control could not mutate the migration");
}

const negativeControl = await runFixture(fixture.replace(marker, negativeControlMigration));
if (
  negativeControl.exitCode === 0 ||
  !negativeControl.stderr.includes("__ack_fetch_negative_control_missing")
) {
  process.stderr.write(negativeControl.stdout);
  process.stderr.write(negativeControl.stderr);
  throw new Error("ACK fetch upgrade negative control did not fail as required");
}

const positive = await runFixture(fixture.replace(marker, migration));
if (
  positive.exitCode !== 0 ||
  /(?:^|\n)\s*not ok\b/i.test(positive.stdout) ||
  !positive.stdout.includes("ok 7 - requeued legacy message can be acknowledged after a real fetch")
) {
  process.stderr.write(positive.stdout);
  process.stderr.write(positive.stderr);
  throw new Error(`ACK fetch upgrade fixture failed with exit code ${positive.exitCode}`);
}

process.stdout.write("ACK fetch forward-upgrade fixture passed its RED control and 7 tests.\n");
