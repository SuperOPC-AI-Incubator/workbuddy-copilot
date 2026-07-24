import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { runRequiredE2EAfterDeploymentGuard } from "./live-deployment-guard.mjs";
import {
  summarizeNegativeControlFailure,
  validateNegativeControlReport,
} from "./playwright-report-contract.mjs";

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

const executable = process.platform === "win32" ? "bunx.exe" : "bunx";

const controls = [
  {
    mode: "signup-role",
    file: "tests/e2e/auth-and-mentor.spec.ts",
    title: "public signup exposes no privileged role choice and provisions only a student",
    marker: "NEGATIVE_CONTROL_SIGNUP_ROLE_REACHED",
  },
  {
    mode: "password-rotation",
    file: "tests/e2e/auth-and-mentor.spec.ts",
    title: "mentor username login is forced through first-password change",
    marker: "NEGATIVE_CONTROL_PASSWORD_ROTATION_REACHED",
  },
  {
    mode: "disabled-session",
    file: "tests/e2e/auth-and-mentor.spec.ts",
    title:
      "team admin creates and disables a mentor whose existing session then loses read and send",
    marker: "NEGATIVE_CONTROL_DISABLED_SESSION_REACHED",
    diagnosticStages: [
      "fixture-setup",
      "admin-create-mentor",
      "mentor-context-create",
      "mentor-password-change",
      "mentor-read-session",
      "admin-disable-mentor",
      "disabled-send-rejected",
      "target-assertion",
      "disabled-session-revoked",
      "mentor-context-close",
      "disabled-state-persisted",
      "fixture-cleanup",
    ],
  },
  {
    mode: "workbuddy-delivery",
    file: "tests/e2e/workbuddy-loop.spec.ts",
    title: "ingest reaches the mentor, reply reaches web and WorkBuddy until acknowledged",
    marker: "NEGATIVE_CONTROL_WORKBUDDY_DELIVERY_REACHED",
  },
];

async function expectRed(control) {
  const { mode, file, title, marker } = control;
  const reportDirectory = resolve("test-results");
  const reportPath = resolve(reportDirectory, `negative-control-${mode}.json`);
  await mkdir(reportDirectory, { recursive: true });
  await rm(reportPath, { force: true });
  const child = spawn(
    executable,
    ["playwright", "test", file, "--grep", title, "--retries=0", "--workers=1"],
    {
      env: {
        ...process.env,
        E2E_REQUIRED: "1",
        E2E_NEGATIVE_CONTROL: mode,
        E2E_NEGATIVE_CONTROL_MARKER: marker,
        PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
  if (exitCode === 0) {
    throw new Error(`E2E negative control unexpectedly passed: ${mode}`);
  }
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    throw new Error(`E2E negative control produced no valid test report: ${mode}`);
  }
  try {
    validateNegativeControlReport(report, control);
  } catch {
    const diagnostic = summarizeNegativeControlFailure(report, control);
    process.stderr.write(`E2E negative control diagnostic: ${JSON.stringify(diagnostic)}\n`);
    throw new Error(`E2E negative control failed before its target assertion: ${mode}`);
  }
  process.stdout.write(`E2E negative control produced RED as required: ${mode}.\n`);
}

await runRequiredE2EAfterDeploymentGuard({
  environment: process.env,
  write: async () => {
    for (const control of controls) {
      await expectRed(control);
    }
  },
});
