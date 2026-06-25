"use strict";

const BROAD_TASK_RE = /(完整|全面|彻底|所有|全部|全量|整个|大范围|不要漏|别漏|scan|audit|全链路|完整链路|architecture|架构)/i;
const RESEARCH_RE = /(分析|排查|调查|研究|梳理|review|investigate|debug|定位|找出)/i;

const MAIN_FIRST_DISPATCH_THRESHOLDS = Object.freeze({
  initialDiscoveryMs: 6000,
  candidateFiles: 20,
  subsystems: 3,
  subagentTargetSeconds: 60,
});

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
    "Main-First Dispatch Gate:",
    `- The main agent must first run deterministic local tools/discovery (\`rg\`, glob/list, file search, workspace index) for up to ${MAIN_FIRST_DISPATCH_THRESHOLDS.initialDiscoveryMs}ms or until it has a candidate map. Do not start Task before this candidate map exists.`,
    `- Stay in the main agent for pure keyword search, TODO/FIXME search, symbol lookup, top-level directory listing, one-subsystem reference checks, or small searches (<${MAIN_FIRST_DISPATCH_THRESHOLDS.candidateFiles} candidate files and <${MAIN_FIRST_DISPATCH_THRESHOLDS.subsystems} subsystems).`,
    `- Use Lily subagents/task agents only when the candidate map exceeds ${MAIN_FIRST_DISPATCH_THRESHOLDS.candidateFiles} files, spans ${MAIN_FIRST_DISPATCH_THRESHOLDS.subsystems}+ independent subsystems, or contains independent hypotheses that can be checked in parallel.`,
    "- If a subagent is started, the parent should keep doing other deterministic work when available instead of idly waiting.",
    `- Treat each subagent as budgeted: target under ${MAIN_FIRST_DISPATCH_THRESHOLDS.subagentTargetSeconds} seconds, return partial evidence if the scope is bigger, and avoid open-ended exploration.`,
    "- Keep each subagent scoped to one subsystem, directory, or hypothesis. Do not stream full file contents back into the main context.",
    "- Each Task prompt must include the exact directory/subsystem/hypothesis, files already known, evidence to collect, output schema, and time budget.",
    "- Nested Task is allowed only when the child finds explicit independent shards; the child must state the shard boundary and return compact evidence.",
    "- Main context should receive only a compact handoff: files inspected, evidence found, decisions, risks, and remaining open questions.",
    "- Treat subagent output as leads, not proof; verify decisive claims with direct file/tool evidence before the final answer.",
    terms.length ? `- Coverage terms to shard first: ${terms.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

module.exports = {
  MAIN_FIRST_DISPATCH_THRESHOLDS,
  buildSubagentIsolationHint,
  shouldUseSubagentIsolation,
};
