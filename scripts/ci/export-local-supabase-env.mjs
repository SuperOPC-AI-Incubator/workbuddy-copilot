import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

const destination = process.argv[2] || process.env.GITHUB_ENV;
if (!destination) throw new Error("GITHUB_ENV destination is required");

const raw = execFileSync("supabase", ["status", "-o", "json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const status = JSON.parse(raw);
const apiUrl = status.API_URL;
const anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
const serviceRoleKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;

if (
  typeof apiUrl !== "string" ||
  !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(apiUrl) ||
  typeof anonKey !== "string" ||
  typeof serviceRoleKey !== "string"
) {
  throw new Error("Supabase CLI did not return a safe local API configuration");
}

const values = {
  SUPABASE_URL: apiUrl,
  VITE_SUPABASE_URL: apiUrl,
  SUPABASE_PUBLISHABLE_KEY: anonKey,
  VITE_SUPABASE_PUBLISHABLE_KEY: anonKey,
  SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  E2E_SUPABASE_URL: apiUrl,
  E2E_SUPABASE_ANON_KEY: anonKey,
  E2E_SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  CLOUD_INTEGRATION_TEST_URL: apiUrl,
  CLOUD_INTEGRATION_SERVICE_ROLE_KEY: serviceRoleKey,
};
const serialized = Object.entries(values)
  .map(([name, value]) => `${name}=${value}\n`)
  .join("");
await appendFile(resolve(destination), serialized, { encoding: "utf8", mode: 0o600 });
process.stdout.write("Local Supabase environment exported without printing credentials.\n");
