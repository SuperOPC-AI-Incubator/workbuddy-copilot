import { describe, expect, test } from "vitest";

import { REQUIRED_E2E_MANIFEST } from "../../scripts/ci/playwright-manifest.mjs";
import {
  summarizeNegativeControlFailure,
  sanitizePlaywrightReport,
  validateNegativeControlReport,
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
  errors?: Array<{ message: string }>;
  retry?: number;
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
      title: file.replace("tests/e2e/", ""),
      file: file.replace("tests/e2e/", ""),
      specs: [
        {
          title,
          file: file.replace("tests/e2e/", ""),
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

const SIGNUP_CONTROL = {
  mode: "signup-role",
  file: "tests/e2e/auth-and-mentor.spec.ts",
  title: REQUIRED_E2E_MANIFEST[0].title,
  marker: "NEGATIVE_CONTROL_SIGNUP_ROLE_REACHED",
};

function negativeControlReport(
  errorMessages: string[],
  rootErrors: unknown[] = [],
): SyntheticReport {
  const report = passingReport([REQUIRED_E2E_MANIFEST[0]]);
  report.errors = rootErrors;
  report.stats.expected = 0;
  report.stats.unexpected = 1;
  const spec = report.suites[0].specs[0];
  spec.ok = false;
  spec.tests[0].results[0] = {
    status: "failed",
    duration: 17,
    retry: 0,
    errors: errorMessages.map((message) => ({ message })),
  };
  return report;
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

  test("rejects shadow, repeated-root, absolute, and traversal report paths", () => {
    for (const invalidFile of [
      "shadow/tests/e2e/tests/e2e/auth-and-mentor.spec.ts",
      "shadow/tests/e2e/auth-and-mentor.spec.ts",
      "/tmp/tests/e2e/auth-and-mentor.spec.ts",
      "../auth-and-mentor.spec.ts",
    ]) {
      const report = passingReport();
      report.suites[0].file = invalidFile;
      report.suites[0].specs[0].file = invalidFile;
      expect(
        () => validateRequiredPlaywrightReport(report, REQUIRED_E2E_MANIFEST),
        invalidFile,
      ).toThrow("manifest");
    }
  });
});

describe("negative-control report contract", () => {
  test("accepts one isolated target assertion error with an exact first-line marker", () => {
    const report = negativeControlReport([`${SIGNUP_CONTROL.marker}\nassertion failure`]);

    expect(() => validateNegativeControlReport(report, SIGNUP_CONTROL)).not.toThrow();
  });

  test("accepts Playwright's concise and detailed views of the same marked assertion", () => {
    const report = negativeControlReport([
      `Error: ${SIGNUP_CONTROL.marker}\n\n${SIGNUP_CONTROL.marker}\ndetailed call log`,
    ]);
    report.suites[0].specs[0].tests[0].results[0].error = {
      message: `Error: ${SIGNUP_CONTROL.marker}\n\n${SIGNUP_CONTROL.marker}\nconcise assertion`,
    };

    expect(() => validateNegativeControlReport(report, SIGNUP_CONTROL)).not.toThrow();
  });

  test("rejects a primary error whose marker differs from its detailed assertion", () => {
    const report = negativeControlReport([
      `Error: ${SIGNUP_CONTROL.marker}\n\n${SIGNUP_CONTROL.marker}\ndetailed call log`,
    ]);
    report.suites[0].specs[0].tests[0].results[0].error = {
      message: "Error: DIFFERENT_ASSERTION_MARKER\nconcise assertion",
    };

    expect(() => validateNegativeControlReport(report, SIGNUP_CONTROL)).toThrow(
      "exactly one target assertion error",
    );
  });

  test("rejects a target assertion failure followed by an afterEach cleanup error", () => {
    const report = negativeControlReport([
      `${SIGNUP_CONTROL.marker}\nassertion failure`,
      "afterEach cleanup failed",
    ]);

    expect(() => validateNegativeControlReport(report, SIGNUP_CONTROL)).toThrow(
      "exactly one target assertion error",
    );
  });

  test("rejects a target assertion accompanied by a root or hook error", () => {
    const report = negativeControlReport(
      [`${SIGNUP_CONTROL.marker}\nassertion failure`],
      [{ message: "afterAll hook failed" }],
    );

    expect(() => validateNegativeControlReport(report, SIGNUP_CONTROL)).toThrow(
      "isolated target failure",
    );
  });

  test("summarizes only an allowlisted failing stage and never raw report context", () => {
    const secret = "password-and-token-from-error-context";
    const report = negativeControlReport(
      [`unexpected failure ${secret}`],
      [{ message: `root error ${secret}` }],
    );
    report.suites[0].specs[0].tests[0].results[0].error = {
      message: `primary error ${secret}`,
    };
    report.suites[0].specs[0].tests[0].results[0].stdout = [`stdout ${secret}`];
    report.suites[0].specs[0].tests[0].results[0].stderr = [`stderr ${secret}`];
    report.suites[0].specs[0].tests[0].results[0].attachments = [
      { name: secret, path: `/tmp/${secret}` },
    ];
    report.suites[0].specs[0].tests[0].results[0].steps = [
      {
        title: `untrusted ${secret}`,
        error: { message: secret },
      },
      {
        title: "disabled-send-rejected",
        error: { message: secret },
      },
    ];
    const control = {
      ...SIGNUP_CONTROL,
      diagnosticStages: ["fixture-setup", "disabled-send-rejected"],
    };

    const summary = summarizeNegativeControlFailure(report, control);

    expect(summary).toEqual({
      title: SIGNUP_CONTROL.title,
      stage: "disabled-send-rejected",
      marker: "absent",
    });
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  test("reports a marked assertion with a secondary error without weakening validation", () => {
    const report = negativeControlReport([
      `${SIGNUP_CONTROL.marker}\nassertion failure`,
      "cleanup failure with a sensitive identifier",
    ]);
    const control = {
      ...SIGNUP_CONTROL,
      diagnosticStages: ["target-assertion"],
    };

    expect(summarizeNegativeControlFailure(report, control)).toEqual({
      title: SIGNUP_CONTROL.title,
      stage: "target-with-secondary-error",
      marker: SIGNUP_CONTROL.marker,
    });
    expect(() => validateNegativeControlReport(report, control)).toThrow(
      "exactly one target assertion error",
    );
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
