"use strict";

const COVERAGE_TERMS = [
  "all",
  "complete",
  "exhaustive",
  "full",
  "thorough",
  "全部",
  "全量",
  "完整",
  "彻底",
  "所有",
  "不要漏",
  "别漏",
  "审计",
  "整个项目",
  "全项目",
];

const FRESHNESS_TERMS = [
  "latest",
  "recent",
  "最新",
  "实时",
  "搜索",
  "查一下",
  "联网",
];

function lowerText(text = "") {
  return String(text || "").toLowerCase();
}

function hasAnyTerm(text, terms) {
  const source = lowerText(text);
  return terms.some((term) => source.includes(String(term).toLowerCase()));
}

function buildTurnPolicy({ text = "", taskContract = null } = {}) {
  const active = Boolean(taskContract?.active);
  const requiresFreshness = hasAnyTerm(text, FRESHNESS_TERMS);
  const requiresSourceCoverage = Boolean(taskContract?.sourceCoveragePolicy?.required);
  const requiresWorkspaceGrounding = Boolean(taskContract?.workspaceGroundingPolicy?.required);
  const coverageIntent = active && hasAnyTerm(text, COVERAGE_TERMS);
  const groundedIntent = active || requiresFreshness || requiresSourceCoverage || requiresWorkspaceGrounding;
  const rigor = coverageIntent ? "coverage" : groundedIntent ? "grounded" : "fast";
  const coverage = rigor === "coverage";
  const grounded = rigor === "grounded";
  const memoryBudget = coverage
    ? { maxChars: 5000 }
    : grounded
      ? { maxChars: 3000 }
      : { maxChars: 0, criticalMaxChars: 1200 };

  return {
    schemaVersion: 1,
    taskType: taskContract?.taskType || "chat",
    categories: Array.isArray(taskContract?.categories) ? taskContract.categories.slice() : [],
    rigor,
    requiresFreshness,
    requiresWorkspaceGrounding,
    requiresSourceCoverage: Boolean(requiresSourceCoverage || coverage),
    allowedClaimStrength: coverage ? "verified" : grounded ? "bounded" : "casual",
    evidenceBudget: coverage
      ? { maxPlanningMs: 2500, maxSearchMs: 6000, maxFilesToRead: 80, maxToolCallsBeforeAsk: 50 }
      : grounded
        ? { maxPlanningMs: 1200, maxSearchMs: 2500, maxFilesToRead: 20, maxToolCallsBeforeAsk: 25 }
        : { maxPlanningMs: 300, maxSearchMs: 0, maxFilesToRead: 4, maxToolCallsBeforeAsk: 12 },
    memoryBudget,
    finalAnswer: {
      requireEvidenceSummary: groundedIntent,
      allowDowngrade: true,
      allowAutoContinue: coverage,
    },
    sourceCoverage: taskContract?.sourceCoveragePolicy || null,
    evidencePolicy: taskContract?.evidencePolicy || null,
    workspaceGroundingPolicy: taskContract?.workspaceGroundingPolicy || null,
  };
}

module.exports = {
  buildTurnPolicy,
};
