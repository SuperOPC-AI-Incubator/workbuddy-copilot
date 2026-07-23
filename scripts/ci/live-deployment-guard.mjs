import { createHash } from "node:crypto";

function exactOrigin(value, label, allowLocalHttp = false) {
  if (!value) throw new Error(`${label} is required`);
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(allowLocalHttp && local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be an exact origin`);
  }
  return { local, url };
}

function exactHttpsOrigin(value, label) {
  const parsed = exactOrigin(value, label);
  if (parsed.local) throw new Error(`${label} must be a remote HTTPS origin`);
  return parsed.url;
}

function hostHash(url) {
  return createHash("sha256").update(url.hostname.toLowerCase(), "utf8").digest("hex");
}

export async function verifyLiveDeploymentBeforeWrite({
  appOrigin,
  expectedSupabaseUrl,
  fetchImpl = fetch,
  write,
}) {
  const appUrl = exactHttpsOrigin(appOrigin, "Live predeploy app origin");
  const supabaseUrl = exactHttpsOrigin(expectedSupabaseUrl, "Live predeploy Supabase URL");
  const expectedHash = hostHash(supabaseUrl);
  const identityUrl = new URL("/api/public/deployment-identity", appUrl);
  const response = await fetchImpl(identityUrl, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });

  let identity;
  try {
    identity = await response.json();
  } catch {
    throw new Error("Live predeploy app returned an invalid deployment identity");
  }

  const valid =
    response.ok &&
    identity &&
    typeof identity === "object" &&
    identity.consistent === true &&
    identity.server_host_sha256 === expectedHash &&
    identity.browser_host_sha256 === expectedHash;
  if (!valid) {
    throw new Error("Live app and E2E target are not the same Supabase test project");
  }

  return write();
}

export function isRemoteE2EOrigin(value) {
  if (!value) return false;
  return !exactOrigin(value, "E2E origin", true).local;
}

export async function runRequiredE2EAfterDeploymentGuard({
  environment,
  fetchImpl = fetch,
  write,
}) {
  const appOrigin = environment.E2E_APP_ORIGIN;
  const appIsRemote = isRemoteE2EOrigin(appOrigin);
  const supabaseIsRemote = !exactOrigin(environment.E2E_SUPABASE_URL, "E2E Supabase target", true)
    .local;

  if (appIsRemote !== supabaseIsRemote) {
    throw new Error("E2E app and Supabase target must both be local or both be remote");
  }
  if (!appIsRemote) return write();

  if (environment.LIVE_PREDEPLOY_TEST_PROJECT !== "true") {
    throw new Error(
      "LIVE_PREDEPLOY_TEST_PROJECT must equal true before remote required E2E writes",
    );
  }

  return verifyLiveDeploymentBeforeWrite({
    appOrigin,
    expectedSupabaseUrl: environment.E2E_SUPABASE_URL,
    fetchImpl,
    write,
  });
}
