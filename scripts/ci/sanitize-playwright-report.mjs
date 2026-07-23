import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { REQUIRED_E2E_MANIFEST } from "./playwright-manifest.mjs";
import { sanitizePlaywrightReport } from "./playwright-report-contract.mjs";

const source = resolve(process.argv[2] ?? "test-results/required-playwright.json");
const destination = resolve(process.argv[3] ?? "ci-artifacts/playwright-summary.json");

let report = {};
try {
  report = JSON.parse(await readFile(source, "utf8"));
} catch {
  report = {};
}

const summary = sanitizePlaywrightReport(report, REQUIRED_E2E_MANIFEST);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(summary, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
process.stdout.write("Sanitized Playwright summary created from allowlisted fields.\n");
