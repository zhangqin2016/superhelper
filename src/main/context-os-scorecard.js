"use strict";

const CRITICAL_FAST_MEMORY_KINDS = new Set(["evidence_gap", "compaction_state"]);
const EXACT_TOKEN_SOURCES = new Set(["runtime_usage", "provider_tokenizer"]);

function trace(record = {}) {
  return record.meta?.engine?.trace || {};
}

function turnPolicy(record = {}) {
  return record.meta?.turnPolicy || {};
}

function contextMemory(record = {}) {
  return trace(record).contextMemory || null;
}

function evidenceGraph(record = {}) {
  return record.meta?.evidenceGraph || {};
}

function hasOnlyCriticalFastMemory(memory = {}) {
  const items = Array.isArray(memory.items) ? memory.items : [];
  if (!items.length) return true;
  return items.every((item) => CRITICAL_FAST_MEMORY_KINDS.has(item.kind));
}

function check(id, ok, detail = "", level = "required") {
  return { id, ok: Boolean(ok), level, detail };
}

function evaluateContextOsScorecard(record = {}) {
  const policy = turnPolicy(record);
  const engine = record.meta?.engine || {};
  const memory = contextMemory(record);
  const evidence = record.meta?.evidenceSummary || null;
  const isFast = (policy.rigor || "fast") === "fast";
  const isCoverage = policy.rigor === "coverage" || policy.requiresSourceCoverage;
  const checks = [];

  checks.push(check(
    "runtime_boundary",
    engine.textChanged !== undefined,
    "turn archive keeps runtime-owned raw history separate from Lily engine augmentation trace",
  ));

  checks.push(check(
    "token_budget_observable",
    Number(engine.promptChars || 0) >= 0 &&
      Number(engine.estimatedPromptTokens || 0) >= 0 &&
      Boolean(engine.estimatedPromptTokenSource || record.meta?.engine?.trace?.tokenSource || record.usage),
    `token source: ${engine.estimatedPromptTokenSource || "runtime/unknown"}`,
  ));

  checks.push(check(
    "fast_path_bounded",
    !isFast || !memory || !memory.injected || hasOnlyCriticalFastMemory(memory),
    "fast turns may carry only critical continuity memory, never ordinary workspace/project memory",
  ));

  checks.push(check(
    "memory_retrieval_observable",
    !memory || [...(memory.items || []), ...(memory.skipped || [])].every((item) => Number.isFinite(Number(item.semanticRelevance || 0))),
    "memory candidates expose semanticRelevance diagnostics when memory was considered",
  ));

  checks.push(check(
    "coverage_has_evidence",
    !isCoverage || Boolean(evidence && Number(evidence.counts?.events || 0) > 0),
    "coverage turns need ledger evidence before strong conclusions",
  ));

  checks.push(check(
    "coverage_has_isolation_contract",
    !isCoverage || trace(record).subagentIsolation?.enabled === true,
    "coverage turns should isolate broad research through OpenCode-native subagents/task agents",
  ));

  checks.push(check(
    "evidence_graph_available",
    Boolean(record.meta?.evidenceGraph?.nodes?.length),
    "archived turns should expose a compact evidence graph for replay/debugging",
    "recommended",
  ));

  checks.push(check(
    "beat_exact_tokenizer",
    EXACT_TOKEN_SOURCES.has(engine.estimatedPromptTokenSource),
    `exact token accounting source: ${engine.estimatedPromptTokenSource || "missing"}`,
    "stretch",
  ));

  checks.push(check(
    "beat_durable_semantic_index",
    memory?.diagnostics?.semanticIndex === "durable",
    "semantic retrieval is durable/index-backed, not only per-turn local vector fallback",
    "stretch",
  ));

  checks.push(check(
    "beat_subagent_runtime_telemetry",
    Boolean(isCoverage && evidenceGraph(record).nodes?.some((node) => node.type === "subagent_handoff")),
    "coverage turns expose real subagent handoff telemetry as evidence graph nodes",
    "stretch",
  ));

  checks.push(check(
    "beat_evidence_replay_bundle",
    Boolean(record.meta?.evidenceReplayBundle?.items?.length),
    "evidence replay can open original tool/file evidence, not only the compact graph",
    "stretch",
  ));

  const required = checks.filter((item) => item.level === "required");
  const stretch = checks.filter((item) => item.level === "stretch");
  const passedRequired = required.filter((item) => item.ok).length;
  const passedStretch = stretch.filter((item) => item.ok).length;
  const passed = checks.filter((item) => item.ok).length;
  return {
    schemaVersion: 1,
    score: required.length ? Math.round((passedRequired / required.length) * 100) : 100,
    stretchScore: stretch.length ? Math.round((passedStretch / stretch.length) * 100) : 100,
    overall: required.every((item) => item.ok) ? "pass" : "attention",
    maturity: {
      parity: required.every((item) => item.ok) ? "pass" : "attention",
      beat: stretch.length && stretch.every((item) => item.ok) ? "pass" : "incomplete",
    },
    passed,
    total: checks.length,
    checks,
  };
}

module.exports = {
  evaluateContextOsScorecard,
};
