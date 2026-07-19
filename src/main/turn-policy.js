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

const COVERAGE_ACTION_TERMS = [
  "analyze",
  "audit",
  "check",
  "find",
  "inspect",
  "review",
  "scan",
  "分析",
  "检查",
  "排查",
  "审计",
  "找出",
  "梳理",
  "扫描",
  "看",
];

const SOURCE_SCOPE_TERMS = [
  "code",
  "codebase",
  "file",
  "project",
  "repo",
  "repository",
  "source",
  "workspace",
  "bug",
  "issue",
  "occurrence",
  "reference",
  "usage",
  "项目",
  "仓库",
  "代码",
  "源码",
  "文件",
  "目录",
  "模块",
  "链路",
  "逻辑",
  "问题",
  "bug",
  "引用",
  "调用",
  "位置",
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

function hasBroadCoverageIntent(text = "") {
  const source = lowerText(text);
  if (!source) return false;
  const orderedPatterns = [
    /(?:彻底|全面|完整|全量).{0,16}(?:分析|检查|排查|审计|找出|梳理|扫描|看)/i,
    /(?:分析|检查|排查|审计|找出|梳理|扫描|看).{0,20}(?:整个项目|全项目|所有|全部|全量|完整|不要漏|别漏)/i,
    /(?:all|every|entire|whole|complete|full|thorough|exhaustive).{0,32}(?:project|repo|repository|codebase|source|file|occurrence|reference|usage|bug|issue)/i,
    /(?:analyze|audit|check|find|inspect|review|scan).{0,32}(?:all|every|entire|whole|complete|full|thorough|exhaustive)/i,
  ];
  if (orderedPatterns.some((pattern) => pattern.test(source))) return true;
  return hasAnyTerm(source, COVERAGE_TERMS) && hasAnyTerm(source, COVERAGE_ACTION_TERMS) && hasAnyTerm(source, SOURCE_SCOPE_TERMS);
}

function buildTurnPolicy({ text = "", taskContract = null } = {}) {
  const active = Boolean(taskContract?.active);
  const requiresFreshness = Boolean(taskContract?.externalFactPolicy?.requiresFreshness) || hasAnyTerm(text, FRESHNESS_TERMS);
  const requiresSourceCoverage = Boolean(taskContract?.sourceCoveragePolicy?.required);
  const requiresWorkspaceGrounding = Boolean(taskContract?.workspaceGroundingPolicy?.required);
  const broadCoverageIntent = hasBroadCoverageIntent(text);
  const coverageIntent = broadCoverageIntent || (active && hasAnyTerm(text, COVERAGE_TERMS));
  const groundedIntent = active || coverageIntent || requiresFreshness || requiresSourceCoverage || requiresWorkspaceGrounding;
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
  hasBroadCoverageIntent,
};
