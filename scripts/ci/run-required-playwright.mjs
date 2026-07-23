import { mkdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { runRequiredE2EAfterDeploymentGuard } from "./live-deployment-guard.mjs";
import { REQUIRED_E2E_MANIFEST } from "./playwright-manifest.mjs";
import { validateRequiredPlaywrightReport } from "./playwright-report-contract.mjs";

const required = [
  "E2E_SUPABASE_URL",
  "E2E_SUPABASE_ANON_KEY",
  "E2E_SUPABASE_SERVICE_ROLE_KEY",
  "E2E_TEST_PASSWORD",
  "E2E_TEST_NEW_PASSWORD",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(`Required E2E configuration is missing: ${missing.join(", ")}`);
}

const reportDirectory = resolve("test-results");
const reportPath = resolve(reportDirectory, "required-playwright.json");

await runRequiredE2EAfterDeploymentGuard({
  environment: process.env,
  write: async () => {
    await mkdir(reportDirectory, { recursive: true });
    await rm(reportPath, { force: true });

    const executable = process.platform === "win32" ? "bunx.exe" : "bunx";
    const child = spawn(executable, ["playwright", "test"], {
      env: {
        ...process.env,
        E2E_REQUIRED: "1",
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
      },
      stdio: "inherit",
    });
    const exitCode = await new Promise((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code) => resolveExit(code ?? 1));
    });

    if (exitCode !== 0) {
      process.exitCode = exitCode;
      return;
    }

    const report = JSON.parse(await readFile(reportPath, "utf8"));
    validateRequiredPlaywrightReport(report, REQUIRED_E2E_MANIFEST);
    process.stdout.write(
      `Required E2E suite passed the exact ${REQUIRED_E2E_MANIFEST.length}-case manifest.\n`,
    );
  },
});
