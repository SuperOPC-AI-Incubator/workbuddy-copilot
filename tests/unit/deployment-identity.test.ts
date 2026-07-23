import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  createDeploymentIdentityResponse,
  supabaseProjectHostHash,
} from "@/lib/deployment-identity";

describe("deployment identity", () => {
  test("publishes only matching server-runtime and browser-build host hashes", async () => {
    const response = createDeploymentIdentityResponse({
      serverUrl: "https://Example.Supabase.co/",
      browserUrl: "https://example.supabase.co/",
    });
    const expectedHash = createHash("sha256").update("example.supabase.co", "utf8").digest("hex");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      server_host_sha256: expectedHash,
      browser_host_sha256: expectedHash,
      consistent: true,
    });
  });

  test("fails closed when the runtime server and browser build target different projects", async () => {
    const response = createDeploymentIdentityResponse({
      serverUrl: "https://test-project.supabase.co/",
      browserUrl: "https://production-project.supabase.co/",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      server_host_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      browser_host_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      consistent: false,
    });
  });

  test("fails closed without exposing a URL when either deployment value is absent", async () => {
    const response = createDeploymentIdentityResponse({
      serverUrl: "https://test-project.supabase.co/",
      browserUrl: undefined,
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      server_host_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      browser_host_sha256: null,
      consistent: false,
    });
    expect(JSON.stringify(body)).not.toContain("supabase.co");
  });

  test("rejects missing, non-HTTPS, credential-bearing, and path-scoped URLs", () => {
    for (const candidate of [
      undefined,
      "http://example.supabase.co",
      "https://user:pass@example.supabase.co",
      "https://example.supabase.co/rest",
    ]) {
      expect(() => supabaseProjectHostHash(candidate)).toThrow();
    }
  });
});
