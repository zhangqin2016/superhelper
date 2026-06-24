"use strict";

const BROAD_TASK_RE = /(完整|全面|彻底|所有|全部|全量|整个|大范围|不要漏|别漏|scan|audit|全链路|完整链路|architecture|架构)/i;
const RESEARCH_RE = /(分析|排查|调查|研究|梳理|review|investigate|debug|定位|找出)/i;

function shouldUseSubagentIsolation({ text = "", turnPolicy = {}, taskContract = null } = {}) {
  if (turnPolicy?.rigor === "coverage" || turnPolicy?.requiresSourceCoverage) return true;
  const source = String(text || "");
  if (BROAD_TASK_RE.test(source) && RESEARCH_RE.test(source)) return true;
  if (Array.isArray(taskContract?.verificationStrategy) && taskContract.verificationStrategy.length >= 3) return true;
  return false;
}

function buildSubagentIsolationHint(input = {}) {
  if (!shouldUseSubagentIsolation(input)) return "";
  const terms = Array.isArray(input.turnPolicy?.sourceCoverage?.explicitTerms)
    ? input.turnPolicy.sourceCoverage.explicitTerms.slice(0, 8).filter(Boolean)
    : [];
  return [
    "Subagent Context Isolation:",
    "- For broad research, audit, source-coverage, or multi-file investigation work, prefer OpenCode native subagents/task agents when available.",
    "- Keep each subagent scoped to one subsystem, directory, or hypothesis. Do not stream full file contents back into the main context.",
    "- Main context should receive only a compact handoff: files inspected, evidence found, decisions, risks, and remaining open questions.",
    "- Treat subagent output as leads, not proof; verify decisive claims with direct file/tool evidence before the final answer.",
    terms.length ? `- Coverage terms to shard first: ${terms.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

module.exports = {
  buildSubagentIsolationHint,
  shouldUseSubagentIsolation,
};
