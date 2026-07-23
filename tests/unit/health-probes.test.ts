import { describe, expect, test, vi } from "vitest";

import { createHealthResponse } from "@/routes/api/health";
import { createReadyResponse } from "@/routes/api/ready";

describe("deployment health probes", () => {
  test("health reports the immutable release id without caching", async () => {
    const response = createHealthResponse("20260724T021500Z-a1b2c3d");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      release_id: "20260724T021500Z-a1b2c3d",
    });
  });

  test.each([undefined, "", " ", "../current", "release id"])(
    "health fails closed when the release identity is invalid: %s",
    async (releaseId) => {
      const response = createHealthResponse(releaseId);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ status: "unhealthy" });
    },
  );

  test("readiness performs a minimal authenticated Supabase read", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify([{ id: "student-id" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const response = await createReadyResponse({
      supabaseUrl: "https://test-project.supabase.co/",
      serviceRoleKey: "test-service-role-key",
      timeoutMs: 100,
      fetchImpl,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ready" });
    expect(fetchImpl).toHaveBeenCalledOnce();

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://test-project.supabase.co/rest/v1/students?select=id&limit=1");
    expect(init).toMatchObject({ method: "GET", cache: "no-store" });
    expect(new Headers(init?.headers).get("apikey")).toBe("test-service-role-key");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-service-role-key");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    {
      name: "missing URL",
      supabaseUrl: undefined,
      serviceRoleKey: "secret-value",
    },
    {
      name: "missing service role key",
      supabaseUrl: "https://test-project.supabase.co/",
      serviceRoleKey: undefined,
    },
    {
      name: "non-HTTPS URL",
      supabaseUrl: "http://test-project.supabase.co/",
      serviceRoleKey: "secret-value",
    },
    {
      name: "path-scoped URL",
      supabaseUrl: "https://test-project.supabase.co/rest",
      serviceRoleKey: "secret-value",
    },
  ])("readiness fails closed for $name without making a request", async (config) => {
    const fetchImpl = vi.fn<typeof fetch>();

    const response = await createReadyResponse({
      ...config,
      timeoutMs: 100,
      fetchImpl,
    });

    expect(response.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ status: "not_ready" });
  });

  test("readiness treats a non-2xx Supabase response as unavailable without leaking details", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("permission denied at test-project.supabase.co", { status: 403 }),
      );

    const response = await createReadyResponse({
      supabaseUrl: "https://test-project.supabase.co/",
      serviceRoleKey: "super-secret-service-key",
      timeoutMs: 100,
      fetchImpl,
    });

    expect(response.status).toBe(503);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toBe('{"status":"not_ready"}');
    expect(serialized).not.toContain("test-project");
    expect(serialized).not.toContain("super-secret");
  });

  test("readiness aborts a hung dependency within the configured timeout", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const startedAt = Date.now();

    const response = await createReadyResponse({
      supabaseUrl: "https://test-project.supabase.co/",
      serviceRoleKey: "test-service-role-key",
      timeoutMs: 15,
      fetchImpl,
    });

    expect(response.status).toBe(503);
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
