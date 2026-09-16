#!/usr/bin/env node
// Step-budget exhaustion is a NAMED stop: once a turn has spent the engine's
// step budget (one usage.updated per model step) and ended neither
// interrupted nor failed, it is reported as stalled with a budget_exhausted
// continuation handoff — never as a clean completion. Interrupted / failed /
// under-budget turns are untouched; kill switch restores today's behaviour.
// [gate: task-completion-integrity]
// Run: node scripts/test-step-budget-exhaustion.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { evaluateStepBudget, configuredStepBudget } = require("../src/main/turn-step-budget.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

check("there is NO primary step cap by default; the guard only arms when one is set", () => {
  // 2026-09-16: the 160-step cap was removed. It read as a runaway backstop but
  // behaved as a wall — the engine's MAX_STEPS prompt disables tools and forces
  // a summary, so a long task stopped in the same place every round.
  assert.equal(configuredStepBudget({}), 0, "0 means the engine keeps its own Infinity");
  assert.equal(evaluateStepBudget({ stepCount: 100000 }, { code: 0 }, {}).exhausted, false,
    "with no cap the guard never fires, whatever the step count");
  assert.equal(configuredStepBudget({ LILY_OPENCODE_MAX_STEPS: "250" }), 250, "an explicit cap is honoured");
});

check("under budget → not exhausted, no meta", () => {
  const result = evaluateStepBudget({ stepCount: 159 }, {}, { budget: 160 });
  assert.equal(result.exhausted, false);
  assert.deepEqual(result.terminalMeta, {});
  assert.equal(result.notice, "");
});

check("at budget on a clean end → stalled with a budget_exhausted handoff carrying the objective", () => {
  const state = { stepCount: 160, taskContract: { intentContract: { objective: "实现工具平台并集成热门 git 项目" } } };
  const result = evaluateStepBudget(state, { code: 0 }, { budget: 160 });
  assert.equal(result.exhausted, true);
  assert.deepEqual(result.terminalMeta.stepBudgetExhausted, { count: 160, budget: 160 });
  assert.equal(result.terminalMeta.continuationStopReason, "step_budget_exhausted");
  assert.equal(result.terminalMeta.continuationHandoff.reason, "budget_exhausted");
  assert.equal(result.terminalMeta.continuationHandoff.progress, 160);
  assert.deepEqual(result.terminalMeta.continuationHandoff.unfinished, [{ kind: "original_requirement", title: "实现工具平台并集成热门 git 项目" }]);
  assert.match(result.notice, /160 步/);
  assert.match(result.notice, /自动接续/);
});

check("an existing handoff from the todo gate is preserved, not overwritten", () => {
  const handoff = { schemaVersion: 1, reason: "budget_exhausted", progress: 3, unfinished: [{ kind: "todo", title: "写测试" }] };
  const result = evaluateStepBudget({ stepCount: 200 }, { code: 0, continuationHandoff: handoff }, { budget: 160 });
  assert.deepEqual(result.terminalMeta.continuationHandoff, handoff);
});

check("interrupted, already-stalled or failed turns are never re-labelled", () => {
  for (const payload of [{ interruptedByUser: true }, { stalled: true }, { failed: true }, { errorCode: "MODEL_CONNECTION_FAILED" }, { failureCode: "X" }]) {
    assert.equal(evaluateStepBudget({ stepCount: 500 }, payload, { budget: 160 }).exhausted, false, JSON.stringify(payload));
  }
});

check("kill switch and missing counters fail open", () => {
  process.env.LILY_STEP_BUDGET_GUARD = "0";
  assert.equal(evaluateStepBudget({ stepCount: 500 }, {}, { budget: 160 }).exhausted, false);
  delete process.env.LILY_STEP_BUDGET_GUARD;
  assert.equal(evaluateStepBudget({}, {}, { budget: 160 }).exhausted, false);
  assert.equal(evaluateStepBudget(null, null, { budget: 160 }).exhausted, false);
});

check("the runtime event router counts one step per usage.updated and resets per turn", () => {
  const src = require("node:fs").readFileSync(new URL("../src/main/turn-runtime-event-router.js", import.meta.url), "utf8");
  assert.match(src, /state\.stepCount = \(Number\(state\.stepCount\) \|\| 0\) \+ 1/);
  const orchestrator = require("node:fs").readFileSync(new URL("../src/main/turn-orchestrator.js", import.meta.url), "utf8");
  assert.equal((orchestrator.match(/state\.stepCount = 0;/g) || []).length, 2, "both per-turn state resets zero the step counter");
  assert.match(orchestrator, /evaluateStepBudget\(state, payload\)/);
  assert.match(orchestrator, /Boolean\(payload\?\.stalled\) \|\| stepBudget\.exhausted/);
});

console.log(`\n${checks} checks passed (step budget exhaustion)`);
