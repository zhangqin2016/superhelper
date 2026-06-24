#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildTaskContract } = require("../src/main/task-contract.js");
const { buildTurnPolicy } = require("../src/main/turn-policy.js");

const casual = buildTurnPolicy({
  text: "你好，今天能帮我做什么",
  taskContract: buildTaskContract({ text: "你好，今天能帮我做什么" }),
});
assert.equal(casual.rigor, "fast");
assert.equal(casual.requiresSourceCoverage, false);
assert.equal(casual.finalAnswer.requireEvidenceSummary, false);
assert.equal(casual.memoryBudget.maxChars, 0);
assert.equal(casual.memoryBudget.criticalMaxChars, 1200);

const code = buildTurnPolicy({
  text: "分析 turn-orchestrator 的 finalize 流程",
  taskContract: buildTaskContract({ text: "分析 turn-orchestrator 的 finalize 流程" }),
});
assert.equal(code.rigor, "grounded");
assert.equal(code.requiresWorkspaceGrounding, true);
assert.equal(code.requiresSourceCoverage, true);
assert.equal(code.allowedClaimStrength, "bounded");
assert(code.evidenceBudget.maxFilesToRead > casual.evidenceBudget.maxFilesToRead);
assert.equal(code.memoryBudget.maxChars, 3000);

const exhaustive = buildTurnPolicy({
  text: "彻底找出整个项目里所有 session.idle 相关问题，不要漏",
  taskContract: buildTaskContract({ text: "彻底找出整个项目里所有 session.idle 相关问题，不要漏" }),
});
assert.equal(exhaustive.rigor, "coverage");
assert.equal(exhaustive.requiresSourceCoverage, true);
assert.equal(exhaustive.allowedClaimStrength, "verified");
assert.equal(exhaustive.finalAnswer.allowAutoContinue, true);
assert.equal(exhaustive.memoryBudget.maxChars, 5000);

const fresh = buildTurnPolicy({
  text: "搜索今天最新的 OpenCode 文档然后回答",
  taskContract: buildTaskContract({ text: "搜索今天最新的 OpenCode 文档然后回答" }),
});
assert.equal(fresh.requiresFreshness, true);
assert.equal(fresh.rigor, "grounded");

console.log("turn-policy: ok");
