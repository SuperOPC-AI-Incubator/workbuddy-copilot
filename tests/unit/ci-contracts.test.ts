import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const root = process.cwd();
const read = (path: string) => readFile(resolve(root, path), "utf8");

describe("cloud-loop CI contracts", () => {
  test("runs quality and a mandatory ephemeral Supabase browser loop", async () => {
    const workflow = await read(".github/workflows/ci.yml");

    expect(workflow).toMatch(/permissions:\s*\n\s+contents:\s+read/);
    expect(workflow).toMatch(/bun install --frozen-lockfile/);
    expect(workflow).toMatch(/supabase start/);
    expect(workflow).toMatch(/supabase db reset/);
    expect(workflow).toMatch(/supabase test db/);
    expect(workflow).toMatch(/test:integration:required/);
    expect(workflow).toMatch(/test:e2e:negative-control/);
    expect(workflow).toMatch(/test:e2e:local/);
    expect(workflow).toMatch(/if:\s*always\(\)[\s\S]*supabase stop/);
  });

  test("runs the real connector installers on Linux, macOS, and Windows", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    const posix = await read("tests/connectors/test-posix.sh");
    const windows = await read("tests/connectors/test-windows.ps1");

    expect(workflow).toMatch(/ubuntu-latest/);
    expect(workflow).toMatch(/macos-latest/);
    expect(workflow).toMatch(/windows-latest/);
    expect(workflow).toContain("tests/connectors/test-posix.sh");
    expect(workflow).toContain("tests/connectors/test-windows.ps1");
    expect(posix).toMatch(/--no-schedule/);
    expect(posix).toMatch(/CRON_BEFORE/);
    expect(posix).toMatch(/com\.superbrain\.workbuddy-sync\.plist/);
    expect(posix).toMatch(/config\.json/);
    expect(posix).toMatch(/SKILL\.md/);
    expect(windows).toMatch(/-NoSchedule/);
    expect(windows).toMatch(/Get-Acl/);
    expect(windows).toMatch(/SecurityIdentifier/);
    expect(windows).toMatch(/ACL grants access to an unexpected principal/);
    expect(windows).toMatch(/workbuddy-sync\.ps1/);
  });

  test("required wrappers reject empty and skipped suites", async () => {
    const integration = await read("scripts/ci/run-required-vitest.mjs");
    const e2e = await read("scripts/ci/run-required-playwright.mjs");
    const negativeControl = await read("scripts/ci/run-e2e-negative-controls.mjs");
    const playwrightConfig = await read("playwright.config.ts");
    const manifest = await read("scripts/ci/playwright-manifest.mjs");
    const reportContract = await read("scripts/ci/playwright-report-contract.mjs");
    const authE2E = await read("tests/e2e/auth-and-mentor.spec.ts");
    const workbuddyE2E = await read("tests/e2e/workbuddy-loop.spec.ts");

    expect(integration).toMatch(/numTotalTests/);
    expect(integration).toMatch(/numPendingTests/);
    expect(e2e).toMatch(/E2E_REQUIRED/);
    expect(reportContract).toMatch(/stats\.expected/);
    expect(reportContract).toMatch(/stats\.skipped/);
    expect(reportContract).toMatch(/stats\.unexpected/);
    expect(reportContract).toMatch(/stats\.flaky/);
    expect(reportContract).toMatch(/infrastructureErrors\.length !== 0/);
    expect(reportContract).toMatch(/resultErrors\.length !== 1/);
    expect(reportContract).toMatch(/assertionMarkerLine/);
    expect(reportContract).not.toMatch(/lastIndexOf/);
    expect(negativeControl).toMatch(/validateNegativeControlReport/);
    expect(negativeControl).toMatch(
      /await runRequiredE2EAfterDeploymentGuard\(\{[\s\S]*write:\s*async\s*\(\)\s*=>\s*\{[\s\S]*for \(const control of controls\)/,
    );
    expect(negativeControl.match(/NEGATIVE_CONTROL_[A-Z_]+_REACHED/g)).toHaveLength(4);
    expect(`${authE2E}\n${workbuddyE2E}`).not.toMatch(/NEGATIVE_CONTROL_[A-Z_]+_REACHED/);
    expect(manifest.match(/tests\/e2e\/[a-z-]+\.spec\.ts/g)).toHaveLength(4);
    expect(e2e).toMatch(/validateRequiredPlaywrightReport/);
    expect(e2e).toMatch(/runRequiredE2EAfterDeploymentGuard/);
    expect(e2e).toMatch(
      /await runRequiredE2EAfterDeploymentGuard\(\{[\s\S]*write:\s*async\s*\(\)\s*=>\s*\{[\s\S]*const child = spawn/,
    );
    expect(playwrightConfig).toMatch(/process\.env\.CI/);
    expect(playwrightConfig).toMatch(/trace:\s*retainBrowserArtifacts[^]*:\s*"off"/);
  });

  test("predeploy is an explicit test-project opt-in, never an implicit production pass", async () => {
    const workflow = await read(".github/workflows/ci.yml");
    const preflight = await read("scripts/ci/assert-live-test-environment.mjs");
    const deploymentRoute = await read("src/routes/api/public/deployment-identity.ts");
    const browserClient = await read("src/integrations/supabase/client.ts");
    const publicConfig = await read("src/integrations/supabase/public-config.ts");

    expect(workflow).toContain("LIVE_PREDEPLOY_ENABLED");
    expect(workflow).toContain("LIVE_PREDEPLOY_TEST_PROJECT");
    expect(preflight).toMatch(/LIVE_PREDEPLOY_TEST_PROJECT/);
    expect(preflight).toMatch(/must equal true/);
    expect(preflight).toMatch(/verifyLiveDeploymentBeforeWrite/);
    expect(deploymentRoute).toMatch(/SUPABASE_URL/);
    expect(deploymentRoute).toMatch(/PUBLIC_SUPABASE_URL/);
    expect(browserClient).toMatch(/PUBLIC_SUPABASE_URL/);
    expect(publicConfig).toMatch(/import\.meta\.env\.VITE_SUPABASE_URL/);
  });

  test("uploads only sanitized browser summaries and disables CI prompt copying", async () => {
    const workflow = await read(".github/workflows/ci.yml");

    expect(workflow.match(/PLAYWRIGHT_NO_COPY_PROMPT:\s*"1"/g)).toHaveLength(2);
    expect(workflow).toMatch(/sanitize-playwright-report\.mjs/);
    expect(workflow).toMatch(/playwright-summary\.json/);
    expect(workflow).not.toMatch(/path:\s*(?:test-results|playwright-report)\//);
  });

  test("forbidden deployment hosts and private artifact registries are gated", async () => {
    const gate = await read("scripts/ci/check-forbidden-hosts.mjs");

    expect(gate).toMatch(/lovable\.app/);
    expect(gate).toMatch(/works\.dev/);
    expect(gate).toMatch(/pkg\.dev/);
    expect(gate).toMatch(/bun\.lock/);
    expect(gate).toMatch(/public/);
    expect(gate).toMatch(/src/);
  });
});
