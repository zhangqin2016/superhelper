/**
 * Pure release policy for model eval results.
 *
 * Full-suite runs are meaningful only against a committed baseline. Explicit
 * one-case runs remain useful for diagnosis without a baseline and therefore
 * fail on the selected case itself. Baseline creation is allowed to bootstrap
 * a new model profile.
 */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasBooleanPass(value) {
  return isRecord(value) && typeof value.pass === "boolean";
}

function normalizedCaseIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || "").trim()).filter(Boolean))];
}

function coverage(expectedIds, actualIds) {
  const expected = new Set(expectedIds);
  const actual = new Set(actualIds);
  return {
    missing: expectedIds.filter((id) => !actual.has(id)),
    unexpected: actualIds.filter((id) => !expected.has(id)),
  };
}

export function parseModelEvalArgs(argv, knownCaseIds) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value)) : [];
  const updateBaseline = args.includes("--update-baseline");
  const knownList = Array.isArray(knownCaseIds)
    ? knownCaseIds.map((id) => String(id || "").trim())
    : [];
  if (
    !knownList.length ||
    knownList.some((id) => !id) ||
    new Set(knownList).size !== knownList.length
  ) {
    return { ok: false, error: "INVALID_CASE_DEFINITIONS", onlyCase: "", updateBaseline };
  }
  const caseIndexes = args.flatMap((value, index) => value === "--case" ? [index] : []);
  if (caseIndexes.length > 1) {
    return { ok: false, error: "DUPLICATE_CASE", onlyCase: "", updateBaseline };
  }
  const caseIndex = caseIndexes[0] ?? -1;
  if (caseIndex < 0) return { ok: true, onlyCase: "", updateBaseline };

  const onlyCase = String(args[caseIndex + 1] || "").trim();
  if (!onlyCase || onlyCase.startsWith("-")) {
    return { ok: false, error: "CASE_VALUE_REQUIRED", onlyCase: "", updateBaseline };
  }
  const known = new Set(knownList);
  if (!known.has(onlyCase)) {
    return { ok: false, error: "UNKNOWN_CASE", onlyCase, updateBaseline };
  }
  return { ok: true, onlyCase, updateBaseline };
}

export function evaluateModelEval({
  results,
  baseline,
  onlyCase = "",
  updateBaseline = false,
  expectedCaseIds,
}) {
  const resultEntries = isRecord(results) ? Object.entries(results) : [];
  const failedCases = resultEntries
    .filter(([, value]) => value?.pass === false)
    .map(([id]) => id);

  if (onlyCase) {
    const selected = isRecord(results) ? results[onlyCase] : null;
    const selectedFailed = !hasBooleanPass(selected) || selected.pass === false;
    return {
      exitCode: selectedFailed ? 1 : 0,
      failedCases: selectedFailed ? [onlyCase] : [],
      regressions: [],
    };
  }

  if (!resultEntries.length) {
    return { exitCode: 2, failedCases, regressions: [], setupError: "EMPTY_RESULTS" };
  }
  if (resultEntries.some(([, value]) => !hasBooleanPass(value))) {
    return { exitCode: 2, failedCases, regressions: [], setupError: "INVALID_RESULTS" };
  }

  const baselineResults = isRecord(baseline?.results) ? baseline.results : null;
  const requestedCaseIds = normalizedCaseIds(expectedCaseIds);
  const rawExpectedCaseIds = Array.isArray(expectedCaseIds)
    ? expectedCaseIds.map((id) => String(id || "").trim())
    : [];
  if (
    expectedCaseIds !== undefined &&
    (
      !Array.isArray(expectedCaseIds) ||
      !rawExpectedCaseIds.length ||
      rawExpectedCaseIds.some((id) => !id) ||
      new Set(rawExpectedCaseIds).size !== rawExpectedCaseIds.length
    )
  ) {
    return { exitCode: 2, failedCases, regressions: [], setupError: "INVALID_EXPECTED_CASES" };
  }
  const expectedIds = requestedCaseIds.length
    ? requestedCaseIds
    : baselineResults && Object.keys(baselineResults).length
      ? Object.keys(baselineResults)
      : resultEntries.map(([id]) => id);
  const resultCoverage = coverage(expectedIds, resultEntries.map(([id]) => id));
  if (resultCoverage.missing.length || resultCoverage.unexpected.length) {
    return {
      exitCode: 2,
      failedCases,
      regressions: [],
      setupError: "RESULT_COVERAGE_MISMATCH",
      missingResultCases: resultCoverage.missing,
      unexpectedResultCases: resultCoverage.unexpected,
    };
  }

  if (baseline == null && !updateBaseline) {
    return {
      exitCode: 2,
      failedCases,
      regressions: [],
      missingBaseline: true,
    };
  }

  if (baseline == null) {
    return { exitCode: 0, failedCases, regressions: [] };
  }

  const baselineEntries = baselineResults ? Object.entries(baselineResults) : [];
  if (!baselineEntries.length || baselineEntries.some(([, value]) => !hasBooleanPass(value))) {
    return { exitCode: 2, failedCases, regressions: [], setupError: "INVALID_BASELINE" };
  }
  const baselineCoverage = coverage(expectedIds, baselineEntries.map(([id]) => id));
  const baselineCoverageChanged = Boolean(baselineCoverage.missing.length || baselineCoverage.unexpected.length);
  if (baselineCoverageChanged && !updateBaseline) {
    return {
      exitCode: 2,
      failedCases,
      regressions: [],
      setupError: "BASELINE_COVERAGE_MISMATCH",
      missingBaselineCases: baselineCoverage.missing,
      unexpectedBaselineCases: baselineCoverage.unexpected,
    };
  }

  const regressions = baselineEntries
    .filter(([id, previous]) => previous.pass && results[id]?.pass === false)
    .map(([id]) => id);

  return {
    exitCode: regressions.length ? 1 : 0,
    failedCases,
    regressions,
    ...(baselineCoverageChanged ? { baselineRefreshRequired: true } : {}),
  };
}
