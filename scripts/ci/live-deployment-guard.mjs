import { createHash } from "node:crypto";

function exactHttpsOrigin(value, label) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be an exact HTTPS origin`);
  }
  return url;
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
