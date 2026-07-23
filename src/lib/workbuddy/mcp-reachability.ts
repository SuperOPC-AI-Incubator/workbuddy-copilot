export type McpReachability =
  | { status: "reachable"; authorization: "required" | "not_verified" }
  | { status: "unreachable" };

export async function checkMcpReachability(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<McpReachability> {
  try {
    const normalizedOrigin = new URL(origin).origin;
    const mcpUrl = `${normalizedOrigin}/mcp`;
    const metadataResponse = await fetchImpl(
      `${normalizedOrigin}/.well-known/oauth-protected-resource`,
      { method: "GET", headers: { Accept: "application/json" } },
    );
    if (!metadataResponse.ok) return { status: "unreachable" };
    const metadata: unknown = await metadataResponse.json();
    const resource =
      metadata && typeof metadata === "object" && "resource" in metadata ? metadata.resource : null;
    if (resource !== mcpUrl) {
      return { status: "unreachable" };
    }

    const initializeResponse = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "superbrain-workbuddy-setup", version: "1.0.0" },
        },
      }),
    });
    if (initializeResponse.ok) {
      return { status: "reachable", authorization: "not_verified" };
    }
    if (initializeResponse.status === 401 && initializeResponse.headers.has("WWW-Authenticate")) {
      return { status: "reachable", authorization: "required" };
    }
    return { status: "unreachable" };
  } catch {
    return { status: "unreachable" };
  }
}
