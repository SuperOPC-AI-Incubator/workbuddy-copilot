import { verifyLiveDeploymentBeforeWrite } from "./live-deployment-guard.mjs";

const required = [
  "E2E_APP_ORIGIN",
  "E2E_SUPABASE_URL",
  "E2E_SUPABASE_ANON_KEY",
  "E2E_SUPABASE_SERVICE_ROLE_KEY",
  "E2E_TEST_PASSWORD",
  "E2E_TEST_NEW_PASSWORD",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(`Live predeploy configuration is missing: ${missing.join(", ")}`);
}
if (process.env.LIVE_PREDEPLOY_TEST_PROJECT !== "true") {
  throw new Error("LIVE_PREDEPLOY_TEST_PROJECT must equal true before any remote test writes");
}

await verifyLiveDeploymentBeforeWrite({
  appOrigin: process.env.E2E_APP_ORIGIN,
  expectedSupabaseUrl: process.env.E2E_SUPABASE_URL,
  write: () => undefined,
});
process.stdout.write("Live predeploy test-project guard passed.\n");
