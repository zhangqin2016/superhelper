"use strict";

/**
 * What a coverage task should know about subagents. WHEN to start a Task is
 * the model's call — the engine's task tool describes it — so this carries no
 * thresholds: the hardcoded "discover for up to 6000ms, stay in the main agent
 * below 20 files / 3 subsystems, target 60 seconds" held a strong model back on
 * exactly the broad work parallel explorers are for (2026-09-28 audit). What is
 * left are facts that are always true of Lily's engine and of a good handoff.
 * Only coverage tasks — where sharding by term actually pays — get it.
 */
function shouldUseSubagentIsolation({ turnPolicy = {} } = {}) {
  return turnPolicy?.rigor === "coverage" || Boolean(turnPolicy?.requiresSourceCoverage);
}

function buildSubagentIsolationHint(input = {}) {
  if (!shouldUseSubagentIsolation(input)) return "";
  const terms = Array.isArray(input.turnPolicy?.sourceCoverage?.explicitTerms)
    ? input.turnPolicy.sourceCoverage.explicitTerms.slice(0, 8).filter(Boolean)
    : [];
  return [
    "Subagent Context Isolation:",
    "- Subagents cannot spawn their own Task subagents — the engine caps nesting at one level. A child that finds more independent shards than its scope returns them as leads for the MAIN agent to dispatch.",
    "- Scope each subagent to one subsystem, directory or hypothesis, and name what it should return; do not stream full file contents back into the main context.",
    "- The main context should receive a compact handoff: files inspected, evidence found, decisions, risks, open questions.",
    "- Treat subagent output as leads, not proof; verify decisive claims with direct file/tool evidence before the final answer.",
    terms.length ? `- Coverage terms to shard by: ${terms.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

module.exports = {
  buildSubagentIsolationHint,
  shouldUseSubagentIsolation,
};
