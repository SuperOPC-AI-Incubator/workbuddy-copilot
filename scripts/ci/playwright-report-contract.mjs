const INVALID_REPORT_FILE = "\u0000invalid-report-file";
const REPORT_FILE_TO_CANONICAL = new Map([
  ["auth-and-mentor.spec.ts", "tests/e2e/auth-and-mentor.spec.ts"],
  ["workbuddy-loop.spec.ts", "tests/e2e/workbuddy-loop.spec.ts"],
]);
const CANONICAL_MANIFEST_FILES = new Set(REPORT_FILE_TO_CANONICAL.values());

function canonicalReportFile(file) {
  if (file === undefined || file === "") return "";
  if (typeof file !== "string") return INVALID_REPORT_FILE;
  return REPORT_FILE_TO_CANONICAL.get(file) ?? INVALID_REPORT_FILE;
}

function canonicalManifestFile(file) {
  return CANONICAL_MANIFEST_FILES.has(file) ? file : INVALID_REPORT_FILE;
}

export function collectPlaywrightSpecs(report) {
  const collected = [];

  function visitSuite(suite, inheritedFile = "", inheritedInvalid = false) {
    const providedSuiteFile = canonicalReportFile(suite?.file);
    const suiteFile = providedSuiteFile || inheritedFile;
    const suiteInvalid = inheritedInvalid || providedSuiteFile === INVALID_REPORT_FILE;
    for (const spec of Array.isArray(suite?.specs) ? suite.specs : []) {
      const providedSpecFile = canonicalReportFile(spec?.file);
      const specFile = providedSpecFile || suiteFile;
      collected.push({
        ...spec,
        file:
          suiteInvalid || providedSpecFile === INVALID_REPORT_FILE ? INVALID_REPORT_FILE : specFile,
      });
    }
    for (const child of Array.isArray(suite?.suites) ? suite.suites : []) {
      visitSuite(child, suiteFile, suiteInvalid);
    }
  }

  for (const suite of Array.isArray(report?.suites) ? report.suites : []) {
    visitSuite(suite);
  }
  return collected;
}

function manifestKey({ file, title }) {
  return `${canonicalManifestFile(file)}\u0000${title}`;
}

function reportSpecKey({ file, title }) {
  return `${file}\u0000${title}`;
}

function resultDuration(spec) {
  return (Array.isArray(spec?.tests) ? spec.tests : [])
    .flatMap((test) => (Array.isArray(test?.results) ? test.results : []))
    .reduce((total, result) => {
      const duration = Number(result?.duration);
      return total + (Number.isFinite(duration) && duration >= 0 ? duration : 0);
    }, 0);
}

function sanitizedStatus(spec) {
  if (!spec) return "missing";
  const tests = Array.isArray(spec.tests) ? spec.tests : [];
  const results = tests.flatMap((test) => (Array.isArray(test?.results) ? test.results : []));
  if (
    spec.ok === true &&
    results.length > 0 &&
    results.every((result) => result.status === "passed")
  ) {
    return "passed";
  }
  if (results.some((result) => result.status === "skipped")) return "skipped";
  return "failed";
}

export function validateRequiredPlaywrightReport(report, manifest) {
  const expectedManifest = [...manifest];
  const actualSpecs = collectPlaywrightSpecs(report);
  const errors = Array.isArray(report?.errors) ? report.errors : [];
  const stats = report?.stats ?? {};

  if (
    errors.length !== 0 ||
    Number(stats.expected ?? -1) !== expectedManifest.length ||
    Number(stats.skipped ?? -1) !== 0 ||
    Number(stats.unexpected ?? -1) !== 0 ||
    Number(stats.flaky ?? -1) !== 0
  ) {
    throw new Error("Required E2E report has incomplete or non-passing status");
  }

  const expectedKeys = expectedManifest.map(manifestKey).sort();
  const actualKeys = actualSpecs.map(reportSpecKey).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Required E2E report does not match the exact manifest");
  }

  for (const spec of actualSpecs) {
    const tests = Array.isArray(spec.tests) ? spec.tests : [];
    if (
      spec.ok !== true ||
      tests.length !== 1 ||
      tests[0]?.expectedStatus !== "passed" ||
      !Array.isArray(tests[0]?.results) ||
      tests[0].results.length !== 1 ||
      tests[0].results[0]?.status !== "passed"
    ) {
      throw new Error("Required E2E manifest case was not expected and passed exactly once");
    }
  }
}

function errorMessage(error) {
  return typeof error?.message === "string" ? error.message : "";
}

function assertionMarkerLine(error) {
  return errorMessage(error)
    .split(/\r?\n/, 1)[0]
    .replace(/^Error:\s*/, "")
    .trim();
}

export function validateNegativeControlReport(report, control) {
  const specs = collectPlaywrightSpecs(report);
  const infrastructureErrors = Array.isArray(report?.errors) ? report.errors : [];
  const stats = report?.stats ?? {};
  const target = specs[0];
  const tests = Array.isArray(target?.tests) ? target.tests : [];
  const results = Array.isArray(tests[0]?.results) ? tests[0].results : [];
  const result = results[0];
  const resultErrors = Array.isArray(result?.errors)
    ? result.errors
    : result?.error
      ? [result.error]
      : [];

  if (
    Number(stats.unexpected ?? -1) !== 1 ||
    Number(stats.expected ?? -1) !== 0 ||
    Number(stats.skipped ?? -1) !== 0 ||
    Number(stats.flaky ?? -1) !== 0 ||
    infrastructureErrors.length !== 0 ||
    specs.length !== 1 ||
    target?.file !== control.file ||
    target?.title !== control.title ||
    target?.ok !== false ||
    tests.length !== 1 ||
    tests[0]?.expectedStatus !== "passed" ||
    results.length !== 1 ||
    result?.status !== "failed" ||
    Number(result?.retry ?? 0) !== 0
  ) {
    throw new Error(`Negative control report is not an isolated target failure: ${control.mode}`);
  }

  if (
    resultErrors.length !== 1 ||
    (result?.error && assertionMarkerLine(result.error) !== assertionMarkerLine(resultErrors[0]))
  ) {
    throw new Error(
      `Negative control must contain exactly one target assertion error: ${control.mode}`,
    );
  }

  if (assertionMarkerLine(resultErrors[0]) !== control.marker) {
    throw new Error(
      `Negative control error does not start with its exact assertion marker: ${control.mode}`,
    );
  }
}

export function sanitizePlaywrightReport(report, manifest) {
  const byKey = new Map(collectPlaywrightSpecs(report).map((spec) => [reportSpecKey(spec), spec]));

  return manifest.map(({ file, title }) => {
    const spec = byKey.get(manifestKey({ file, title }));
    return {
      file,
      title,
      status: sanitizedStatus(spec),
      count: Array.isArray(spec?.tests) ? spec.tests.length : 0,
      duration: resultDuration(spec),
    };
  });
}
