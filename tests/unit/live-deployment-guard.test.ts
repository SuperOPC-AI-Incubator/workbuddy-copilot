import { describe, expect, test, vi } from "vitest";

import { createDeploymentIdentityResponse } from "@/lib/deployment-identity";
import {
  runRequiredE2EAfterDeploymentGuard,
  verifyLiveDeploymentBeforeWrite,
} from "../../scripts/ci/live-deployment-guard.mjs";

describe("live deployment guard", () => {
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
