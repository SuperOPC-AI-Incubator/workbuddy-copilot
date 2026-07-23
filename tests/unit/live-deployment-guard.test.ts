import { describe, expect, test, vi } from "vitest";

import { createDeploymentIdentityResponse } from "@/lib/deployment-identity";
import {
  runRequiredE2EAfterDeploymentGuard,
  verifyLiveDeploymentBeforeWrite,
} from "../../scripts/ci/live-deployment-guard.mjs";

describe("live deployment guard", () => {
  test.each([
    {
      name: "unset app and local database",
      appOrigin: undefined,
      supabaseUrl: "http://127.0.0.1:54321",
      expectedFetches: 0,
      expectedWrites: 1,
    },
    {
      name: "local app and local database",
      appOrigin: "http://localhost:4173",
      supabaseUrl: "http://127.0.0.1:54321",
      expectedFetches: 0,
      expectedWrites: 1,
    },
    {
      name: "remote app and remote database",
      appOrigin: "https://app.example.test",
      supabaseUrl: "https://test-project.supabase.co",
      expectedFetches: 1,
      expectedWrites: 1,
    },
    {
      name: "unset app and remote database",
      appOrigin: undefined,
      supabaseUrl: "https://test-project.supabase.co",
      expectedFetches: 0,
      expectedWrites: 0,
    },
    {
      name: "local app and remote database",
      appOrigin: "http://127.0.0.1:4173",
      supabaseUrl: "https://test-project.supabase.co",
      expectedFetches: 0,
      expectedWrites: 0,
    },
    {
      name: "remote app and local database",
      appOrigin: "https://app.example.test",
      supabaseUrl: "http://localhost:54321",
      expectedFetches: 0,
      expectedWrites: 0,
    },
  ])(
    "$name follows the local-local or guarded remote-remote policy",
    async ({ appOrigin, supabaseUrl, expectedFetches, expectedWrites }) => {
      const spawn = vi.fn();
      const write = vi.fn(() => spawn());
      const fetchImpl = vi.fn(async () =>
        createDeploymentIdentityResponse({
          serverUrl: supabaseUrl,
          browserUrl: supabaseUrl,
        }),
      );

      const guardedRun = runRequiredE2EAfterDeploymentGuard({
        environment: {
          E2E_APP_ORIGIN: appOrigin,
          E2E_SUPABASE_URL: supabaseUrl,
          LIVE_PREDEPLOY_TEST_PROJECT: "true",
        },
        fetchImpl,
        write,
      });

      if (expectedWrites === 0) {
        await expect(guardedRun).rejects.toThrow(/local|remote/i);
      } else {
        await expect(guardedRun).resolves.toBeUndefined();
      }
      expect(fetchImpl).toHaveBeenCalledTimes(expectedFetches);
      expect(write).toHaveBeenCalledTimes(expectedWrites);
      expect(spawn).toHaveBeenCalledTimes(expectedWrites);
    },
  );

  test("rejects a local-looking URL that is not an exact origin before write", async () => {
    const spawn = vi.fn();
    const write = vi.fn(() => spawn());
    const fetchImpl = vi.fn();

    await expect(
      runRequiredE2EAfterDeploymentGuard({
        environment: {
          E2E_APP_ORIGIN: "http://localhost:4173/preview",
          E2E_SUPABASE_URL: "http://127.0.0.1:54321",
          LIVE_PREDEPLOY_TEST_PROJECT: "true",
        },
        fetchImpl,
        write,
      }),
    ).rejects.toThrow("exact");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  test("rejects a missing Supabase target instead of treating it as local", async () => {
    const spawn = vi.fn();
    const write = vi.fn(() => spawn());
    const fetchImpl = vi.fn();

    await expect(
      runRequiredE2EAfterDeploymentGuard({
        environment: {},
        fetchImpl,
        write,
      }),
    ).rejects.toThrow("required");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  test("does not execute the write callback when browser and server projects differ", async () => {
    const write = vi.fn();
    const fetchImpl = vi.fn(async () =>
      createDeploymentIdentityResponse({
        serverUrl: "https://test-project.supabase.co/",
        browserUrl: "https://production-project.supabase.co/",
      }),
    );

    await expect(
      verifyLiveDeploymentBeforeWrite({
        appOrigin: "https://app.example.test/",
        expectedSupabaseUrl: "https://test-project.supabase.co/",
        fetchImpl,
        write,
      }),
    ).rejects.toThrow("same Supabase test project");
    expect(write).not.toHaveBeenCalled();
  });

  test("direct remote required runner refuses a missing disposable-project guard before spawn", async () => {
    const spawn = vi.fn();
    const write = vi.fn(() => spawn());
    const fetchImpl = vi.fn();

    await expect(
      runRequiredE2EAfterDeploymentGuard({
        environment: {
          E2E_APP_ORIGIN: "https://app.example.test/",
          E2E_SUPABASE_URL: "https://test-project.supabase.co/",
        },
        fetchImpl,
        write,
      }),
    ).rejects.toThrow("LIVE_PREDEPLOY_TEST_PROJECT");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  test("direct remote required runner refuses an identity mismatch before spawn", async () => {
    const spawn = vi.fn();
    const write = vi.fn(() => spawn());
    const fetchImpl = vi.fn(async () =>
      createDeploymentIdentityResponse({
        serverUrl: "https://test-project.supabase.co/",
        browserUrl: "https://production-project.supabase.co/",
      }),
    );

    await expect(
      runRequiredE2EAfterDeploymentGuard({
        environment: {
          E2E_APP_ORIGIN: "https://app.example.test/",
          E2E_SUPABASE_URL: "https://test-project.supabase.co/",
          LIVE_PREDEPLOY_TEST_PROJECT: "true",
        },
        fetchImpl,
        write,
      }),
    ).rejects.toThrow("same Supabase test project");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  test("remote negative-control entry refuses an identity mismatch before its first spawn", async () => {
    const spawn = vi.fn();
    const runControls = vi.fn(() => spawn());
    const fetchImpl = vi.fn(async () =>
      createDeploymentIdentityResponse({
        serverUrl: "https://test-project.supabase.co/",
        browserUrl: "https://production-project.supabase.co/",
      }),
    );

    await expect(
      runRequiredE2EAfterDeploymentGuard({
        environment: {
          E2E_APP_ORIGIN: "https://app.example.test/",
          E2E_SUPABASE_URL: "https://test-project.supabase.co/",
          LIVE_PREDEPLOY_TEST_PROJECT: "true",
        },
        fetchImpl,
        write: runControls,
      }),
    ).rejects.toThrow("same Supabase test project");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(runControls).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
