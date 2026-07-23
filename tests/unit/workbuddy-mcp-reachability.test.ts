import { describe, expect, test, vi } from "vitest";

import { checkMcpReachability } from "../../src/lib/workbuddy/mcp-reachability";

const ORIGIN = "https://copilot.example.test";
const MCP_URL = `${ORIGIN}/mcp`;

function metadataResponse(resource = MCP_URL) {
  return Response.json({ resource });
}

describe("WorkBuddy MCP reachability check", () => {
  test("requires both matching OAuth metadata and a reachable MCP endpoint", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadataResponse())
      .mockResolvedValueOnce(new Response("missing", { status: 404 }));

    await expect(checkMcpReachability(ORIGIN, fetchImpl)).resolves.toEqual({
      status: "unreachable",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      MCP_URL,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"method":"initialize"'),
      }),
    );
  });

  test("accepts a 2xx initialize response or an OAuth 401 challenge as endpoint reachability", async () => {
    const successFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadataResponse())
      .mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    await expect(checkMcpReachability(ORIGIN, successFetch)).resolves.toEqual({
      status: "reachable",
      authorization: "not_verified",
    });

    const challengeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadataResponse())
      .mockResolvedValueOnce(
        new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer resource_metadata="/.well-known/test"' },
        }),
      );
    await expect(checkMcpReachability(ORIGIN, challengeFetch)).resolves.toEqual({
      status: "reachable",
      authorization: "required",
    });
  });

  test("rejects mismatched metadata without probing the unrelated resource", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(metadataResponse("/mcp"));

    await expect(checkMcpReachability(ORIGIN, fetchImpl)).resolves.toEqual({
      status: "unreachable",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
