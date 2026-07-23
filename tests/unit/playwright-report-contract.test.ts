import { describe, expect, test } from "vitest";

import { REQUIRED_E2E_MANIFEST } from "../../scripts/ci/playwright-manifest.mjs";
import {
  sanitizePlaywrightReport,
  validateRequiredPlaywrightReport,
} from "../../scripts/ci/playwright-report-contract.mjs";

type SyntheticResult = {
  status: string;
  duration: number;
  error?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  attachments?: unknown;
  steps?: unknown;
};

type SyntheticReport = {
  suites: Array<{
    title: string;
    file: string;
    specs: Array<{
      title: string;
      file: string;
      ok: boolean;
      tests: Array<{
        expectedStatus: string;
        results: SyntheticResult[];
      }>;
    }>;
  }>;
  errors: unknown[];
  stats: {
    expected: number;
    skipped: number;
    unexpected: number;
    flaky: number;
    duration: number;
  };
};

function passingReport(manifest = REQUIRED_E2E_MANIFEST): SyntheticReport {
  return {
    suites: manifest.map(({ file, title }) => ({
      title: file,
      file,
      specs: [
        {
          title,
          file,
          ok: true,
          tests: [
            {
              expectedStatus: "passed",
              results: [{ status: "passed", duration: 17 }],
            },
          ],
        },
      ],
    })),
    errors: [],
    stats: {
      expected: manifest.length,
      skipped: 0,
      unexpected: 0,
      flaky: 0,
      duration: 68,
    },
  };
}

describe("required Playwright report contract", () => {
  test("accepts exactly the four required file/title pairs when every case passes", () => {
    expect(() =>
      validateRequiredPlaywrightReport(passingReport(), REQUIRED_E2E_MANIFEST),
    ).not.toThrow();
  });

  test("normalizes Playwright JSON file paths relative to testDir", () => {
    const report = passingReport();
    for (const suite of report.suites) {
      suite.file = suite.file.replace("tests/e2e/", "");
      for (const spec of suite.specs) {
        spec.file = spec.file.replace("tests/e2e/", "");
      }
    }

    expect(() => validateRequiredPlaywrightReport(report, REQUIRED_E2E_MANIFEST)).not.toThrow();
  });

  test("rejects replacing one required case with an unrelated passing case", () => {
    const replaced = [
      ...REQUIRED_E2E_MANIFEST.slice(0, -1),
      {
        file: "tests/e2e/unrelated.spec.ts",
        title: "an unrelated passing browser check",
      },
    ];

    expect(() =>
      validateRequiredPlaywrightReport(passingReport(replaced), REQUIRED_E2E_MANIFEST),
    ).toThrow("manifest");
  });
});

describe("sanitized Playwright summary", () => {
  test("copies only allowlisted manifest fields and never secret-bearing report context", () => {
    const secret = "password-from-error-context";
    const report = passingReport();
    report.suites[0].specs[0].tests[0].results[0] = {
      status: "failed",
      duration: 41,
      error: { message: `failed after fill(${secret})` },
      stdout: [`stdout ${secret}`],
      stderr: [`stderr ${secret}`],
      attachments: [{ name: secret, path: `/tmp/${secret}` }],
      steps: [{ title: secret }],
    };
    report.suites.push({
      title: secret,
      file: `tests/e2e/${secret}.spec.ts`,
      specs: [],
    });

    const summary = sanitizePlaywrightReport(report, REQUIRED_E2E_MANIFEST);
    expect(summary).toHaveLength(4);
    for (const row of summary) {
      expect(Object.keys(row).sort()).toEqual(["count", "duration", "file", "status", "title"]);
    }
    expect(JSON.stringify(summary)).not.toContain(secret);
  });
});
