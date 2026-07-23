import { createHash } from "node:crypto";

export function supabaseProjectHostHash(configuredUrl: string | undefined): string {
  if (!configuredUrl) throw new Error("Supabase deployment URL is unavailable");

  const url = new URL(configuredUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Supabase deployment URL is invalid");
  }

  return createHash("sha256").update(url.hostname.toLowerCase(), "utf8").digest("hex");
}

function safeProjectHostHash(configuredUrl: string | undefined): string | null {
  try {
    return supabaseProjectHostHash(configuredUrl);
  } catch {
    return null;
  }
}

export function createDeploymentIdentityResponse(input: {
  serverUrl: string | undefined;
  browserUrl: string | undefined;
}): Response {
  const serverHash = safeProjectHostHash(input.serverUrl);
  const browserHash = safeProjectHostHash(input.browserUrl);
  const consistent = serverHash !== null && browserHash !== null && serverHash === browserHash;

  return Response.json(
    {
      server_host_sha256: serverHash,
      browser_host_sha256: browserHash,
      consistent,
    },
    {
      status: consistent ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
