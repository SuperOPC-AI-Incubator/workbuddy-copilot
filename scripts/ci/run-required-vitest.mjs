import { mkdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const required = [
  "CLOUD_INTEGRATION_TEST_URL",
  "CLOUD_INTEGRATION_SERVICE_ROLE_KEY",
  "CLOUD_INTEGRATION_TEST_STUDENT_ID",
];
const missing = required.filter((name) => !process.env[name]);
if (process.env.CLOUD_INTEGRATION_TEST_ALLOW_WRITES !== "true") {
  missing.push("CLOUD_INTEGRATION_TEST_ALLOW_WRITES=true");
}
if (missing.length > 0) {
  throw new Error(`Required integration configuration is missing: ${missing.join(", ")}`);
}

const reportDirectory = resolve("test-results");
const reportPath = resolve(reportDirectory, "required-vitest.json");
await mkdir(reportDirectory, { recursive: true });
await rm(reportPath, { force: true });

const executable = process.platform === "win32" ? "bunx.exe" : "bunx";
const child = spawn(
  executable,
  [
    "vitest",
    "run",
    "tests/integration/workbuddy-concurrency.test.ts",
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ],
  {
    env: process.env,
    stdio: "inherit",
  },
);
const exitCode = await new Promise((resolveExit, rejectExit) => {
  child.once("error", rejectExit);
  child.once("exit", (code) => resolveExit(code ?? 1));
});

if (exitCode !== 0) {
  process.exitCode = exitCode;
} else {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const numTotalTests = Number(report.numTotalTests ?? 0);
  const numPendingTests = Number(report.numPendingTests ?? 0);
  const numFailedTests = Number(report.numFailedTests ?? 0);
  if (numTotalTests < 3 || numPendingTests !== 0 || numFailedTests !== 0) {
    throw new Error(
      `Required integration suite was incomplete: total=${numTotalTests} pending=${numPendingTests} failed=${numFailedTests}`,
    );
  }
  process.stdout.write(
    `Required integration suite passed ${numTotalTests} tests with 0 skipped.\n`,
  );
}
