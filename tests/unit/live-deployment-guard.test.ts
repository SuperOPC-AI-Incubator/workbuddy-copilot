import { describe, expect, test, vi } from "vitest";

import { createDeploymentIdentityResponse } from "@/lib/deployment-identity";
import { verifyLiveDeploymentBeforeWrite } from "../../scripts/ci/live-deployment-guard.mjs";

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
});
