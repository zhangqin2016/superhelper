#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { evaluateContextOsScorecard } = require("../src/main/context-os-scorecard.js");

const baseRecord = {
  meta: {
    engine: {
      textChanged: true,
      promptChars: 1200,
      estimatedPromptTokens: 380,
      estimatedPromptTokenSource: "estimated_provider_fallback",
      trace: {
        contextMemory: null,
      },
    },
    turnPolicy: { rigor: "fast" },
    evidenceSummary: { counts: { events: 0 } },
    evidenceGraph: { nodes: [{ id: "turn:t1", type: "turn" }], edges: [] },
  },
};

let scorecard = evaluateContextOsScorecard(baseRecord);
assert.equal(scorecard.overall, "pass", "ordinary fast turns stay on the cheap path");
assert.equal(scorecard.maturity.parity, "pass", "required parity checks can pass independently");
assert.equal(scorecard.maturity.beat, "incomplete", "passing parity must not be mistaken for beating Claude Code");
assert.equal(scorecard.checks.find((item) => item.id === "fast_path_bounded").ok, true);
assert.equal(scorecard.checks.find((item) => item.id === "beat_exact_tokenizer").ok, false);
assert.equal(scorecard.checks.find((item) => item.id === "beat_subagent_runtime_telemetry").ok, false, "non-coverage turns cannot satisfy subagent runtime telemetry by being not applicable");
assert.equal(scorecard.checks.find((item) => item.id === "skill_guide_usage_observable").ok, true);
assert.equal(scorecard.checks.find((item) => item.id === "subagent_latency_observable").ok, true);

scorecard = evaluateContextOsScorecard({
  ...baseRecord,
  meta: {
    ...baseRecord.meta,
    engine: {
      ...baseRecord.meta.engine,
      trace: {
        contextMemory: {
          injected: true,
          items: [{ kind: "project_memory", semanticRelevance: 0.4 }],
          skipped: [],
        },
      },
    },
  },
});
assert.equal(scorecard.overall, "attention", "ordinary project memory on fast turns is a regression");
assert.equal(scorecard.checks.find((item) => item.id === "fast_path_bounded").ok, false);

scorecard = evaluateContextOsScorecard({
  ...baseRecord,
  meta: {
    ...baseRecord.meta,
    turnPolicy: { rigor: "coverage", requiresSourceCoverage: true },
    evidenceSummary: { counts: { events: 3 } },
    engine: {
      ...baseRecord.meta.engine,
      trace: {
        contextMemory: {
          injected: true,
          items: [{ kind: "learned_conventions", semanticRelevance: 0.2 }],
          skipped: [{ kind: "workspace_digest", semanticRelevance: 0.1 }],
        },
        subagentIsolation: { enabled: true, reason: "coverage_policy" },
      },
    },
  },
});
assert.equal(scorecard.overall, "pass", "coverage turns pass with evidence and isolation");
assert.equal(scorecard.checks.find((item) => item.id === "coverage_has_evidence").ok, true);
assert.equal(scorecard.checks.find((item) => item.id === "coverage_has_isolation_contract").ok, true);
assert.equal(scorecard.maturity.beat, "incomplete", "prompt-level isolation is not real runtime subagent telemetry");

scorecard = evaluateContextOsScorecard({
  ...baseRecord,
  meta: {
    ...baseRecord.meta,
    turnPolicy: { rigor: "coverage", requiresSourceCoverage: true },
    evidenceSummary: { counts: { events: 0 } },
    engine: {
      ...baseRecord.meta.engine,
      trace: { contextMemory: null },
    },
  },
});
assert.equal(scorecard.overall, "attention", "coverage turns fail without evidence/isolation");
assert.equal(scorecard.checks.find((item) => item.id === "coverage_has_evidence").ok, false);
assert.equal(scorecard.checks.find((item) => item.id === "coverage_has_isolation_contract").ok, false);

scorecard = evaluateContextOsScorecard({
  ...baseRecord,
  meta: {
    ...baseRecord.meta,
    skillUsageAudit: {
      candidateCount: 1,
      candidates: [{ id: "lily-runtime-debug" }],
      missingGuideReads: ["lily-runtime-debug"],
      ok: false,
    },
  },
});
assert.equal(scorecard.overall, "pass", "missing skill-guide reads are advisory and must not block user tasks");
assert.equal(scorecard.checks.find((item) => item.id === "skill_guide_usage_observable").ok, false);

scorecard = evaluateContextOsScorecard({
  ...baseRecord,
  meta: {
    ...baseRecord.meta,
    subagentTelemetry: {
      count: 1,
      slowCount: 1,
      verySlowCount: 1,
      totalDurationMs: 131_000,
      subagents: [{ id: "task_1", durationMs: 131_000 }],
    },
  },
});
assert.equal(scorecard.overall, "pass", "very slow subagent telemetry is advisory and must not block user tasks");
assert.equal(scorecard.checks.find((item) => item.id === "subagent_latency_observable").ok, false);

scorecard = evaluateContextOsScorecard({
  ...baseRecord,
  meta: {
    ...baseRecord.meta,
    evidenceReplayBundle: { items: [{ kind: "tool", id: "tool_1" }] },
    evidenceGraph: {
      nodes: [
        { id: "turn:t1", type: "turn" },
        { id: "subagent:audit", type: "subagent_handoff" },
      ],
      edges: [],
    },
    turnPolicy: { rigor: "coverage", requiresSourceCoverage: true },
    evidenceSummary: { counts: { events: 3 } },
    engine: {
      ...baseRecord.meta.engine,
      estimatedPromptTokenSource: "provider_tokenizer",
      trace: {
        contextMemory: {
          injected: true,
          diagnostics: { semanticIndex: "durable" },
          items: [{ kind: "learned_conventions", semanticRelevance: 0.2 }],
          skipped: [],
        },
        subagentIsolation: { enabled: true, reason: "coverage_policy" },
      },
    },
  },
});
assert.equal(scorecard.maturity.beat, "pass", "stretch maturity requires exact tokens, durable semantic index, subagent telemetry, and replay bundle");
assert.equal(scorecard.stretchScore, 100);

console.log("context-os-scorecard: ok");
