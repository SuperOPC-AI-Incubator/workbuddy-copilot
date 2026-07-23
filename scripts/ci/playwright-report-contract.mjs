function normalizedFile(file) {
  if (typeof file !== "string") return "";
  const normalized = file.replaceAll("\\", "/");
  const marker = "tests/e2e/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex !== -1) return normalized.slice(markerIndex);
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return normalized;
  }
  return `${marker}${normalized.replace(/^\.\//, "")}`;
}

export function collectPlaywrightSpecs(report) {
  const collected = [];

  function visitSuite(suite, inheritedFile = "") {
    const suiteFile = normalizedFile(suite?.file) || inheritedFile;
    for (const spec of Array.isArray(suite?.specs) ? suite.specs : []) {
      collected.push({
        ...spec,
        file: normalizedFile(spec?.file) || suiteFile,
      });
    }
    for (const child of Array.isArray(suite?.suites) ? suite.suites : []) {
      visitSuite(child, suiteFile);
    }
  }

  for (const suite of Array.isArray(report?.suites) ? report.suites : []) {
    visitSuite(suite);
  }
  return collected;
}

function manifestKey({ file, title }) {
  return `${normalizedFile(file)}\u0000${title}`;
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
  const actualKeys = actualSpecs.map(({ file, title }) => manifestKey({ file, title })).sort();
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

export function sanitizePlaywrightReport(report, manifest) {
  const byKey = new Map(collectPlaywrightSpecs(report).map((spec) => [manifestKey(spec), spec]));

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
