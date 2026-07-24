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
const sql = fixture.replace(marker, migration);

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

if (
  exitCode !== 0 ||
  /(?:^|\n)\s*not ok\b/i.test(stdout) ||
  !stdout.includes("ok 7 - requeued legacy message can be acknowledged after a real fetch")
) {
  process.stderr.write(stdout);
  process.stderr.write(stderr);
  throw new Error(`ACK fetch upgrade fixture failed with exit code ${exitCode}`);
}

process.stdout.write("ACK fetch forward-upgrade fixture passed 7 tests.\n");
