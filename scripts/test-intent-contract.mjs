#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  applyModelIntentCandidate,
  buildIntentContract,
  findLatestTaskContractSnapshot,
  relationForText,
} = require("../src/main/intent-contract.js");
const { buildTaskContract } = require("../src/main/task-contract.js");

function archivedAssistant(contract, userText = "修复登录问题") {
  return {
    role: "assistant",
    content: "已完成初步修复。",
    record: {
      terminal: "turn.completed",
      user: { text: userText },
      meta: {
        taskContract: {
          active: true,
          kind: contract.kind,
          taskType: contract.taskType,
          categories: contract.categories,
          verificationStrategy: contract.verificationStrategy,
          externalFact: contract.externalFactPolicy?.required
            ? {
                reasonCodes: contract.externalFactPolicy.reasonCodes,
                researchProhibited: contract.externalFactPolicy.researchProhibited,
                scopeClarificationRecommended: contract.externalFactPolicy.scopeClarificationRecommended,
              }
            : null,
          intentContract: contract.intentContract,
        },
      },
    },
  };
}

assert.equal(relationForText("继续", true), "continue");
assert.equal(relationForText("继续按最优方式推进", true), "continue");
assert.equal(relationForText("不是这个意思，我要修复现有实现", true), "correct");
assert.equal(relationForText("改成中文", true), "refine");
assert.equal(relationForText("新任务：写一份报告", true), "new");
assert.equal(relationForText("新任务：不要修改旧项目", true), "new");
assert.equal(relationForText("继续", false), "new");

const first = buildTaskContract({ text: "修复登录代码并运行测试" });
assert.equal(first.active, true);
assert.equal(first.intentContract.relation, "new");
assert.equal(first.intentContract.revision, 1);
assert(first.intentContract.successCriteria.length > 0);
assert(first.intentContract.deliverables.length > 0);

const history = [
  { role: "user", content: "修复登录代码并运行测试" },
  archivedAssistant(first, "修复登录代码并运行测试"),
];
const continued = buildTaskContract({ text: "继续", messages: history });
assert.equal(continued.active, true, "terse continuation should inherit the active task contract");
assert.equal(continued.taskType, first.taskType);
assert.equal(continued.intentContract.relation, "continue");
assert.equal(continued.intentContract.contractId, first.intentContract.contractId);
assert.equal(continued.intentContract.revision, 2);
assert.equal(continued.intentContract.objective, first.intentContract.objective);
assert.equal(continued.intentContract.currentInstruction, "继续");

const corrected = buildTaskContract({
  text: "不是这个意思，重点是修复现有代码，不要新建项目",
  messages: history,
});
assert.equal(corrected.intentContract.relation, "correct");
assert.equal(corrected.intentContract.contractId, first.intentContract.contractId);
assert(corrected.intentContract.amendments.some((item) => item.includes("重点是修复现有代码")));
assert(corrected.intentContract.constraints.length > 0);

const staleHistory = [
  ...history,
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好，有什么可以帮你？", record: { terminal: "turn.completed", meta: {} } },
];
const stale = buildTaskContract({ text: "继续", messages: staleHistory });
assert.equal(stale.active, false, "a later non-task answer must break stale task inheritance");
const staleSummary = buildTaskContract({
  text: "继续",
  messages: staleHistory,
  previousIntentContract: first.intentContract,
});
assert.equal(staleSummary.active, false, "stale summary data must not override a newer non-task assistant turn");

const snapshot = findLatestTaskContractSnapshot(history);
const inherited = buildIntentContract({
  text: "再加一个回归测试",
  taskType: first.taskType,
  categories: first.categories,
  verificationStrategy: first.verificationStrategy,
  previousSnapshot: snapshot,
});
assert.equal(inherited.relation, "refine");
assert.equal(inherited.revision, 2);

const summaryOnly = buildTaskContract({
  text: "继续",
  messages: [],
  previousIntentContract: first.intentContract,
});
assert.equal(summaryOnly.active, true, "compacted sessions should inherit the summary's latest contract");
assert.equal(summaryOnly.intentContract.contractId, first.intentContract.contractId);

const noSearchRanking = buildTaskContract({
  text: "请给我目前全球最好用的 AI 编程助手 Top 8 排行。不要搜索，也不用给来源。",
});
const rankingHistory = [
  { role: "user", content: noSearchRanking.intentContract.currentInstruction },
  archivedAssistant(noSearchRanking, noSearchRanking.intentContract.currentInstruction),
];
const rankingRefinement = buildTaskContract({ text: "按综合体验排", messages: rankingHistory });
assert.equal(rankingRefinement.taskType, "external_fact");
assert.equal(rankingRefinement.externalFactPolicy.researchProhibited, true, "a terse refinement must preserve no-search");
assert.equal(rankingRefinement.externalFactPolicy.scopeClarificationRecommended, true);
const rankingResearchAllowed = buildTaskContract({
  text: "现在可以联网搜索，按综合体验排行",
  messages: rankingHistory,
});
assert.equal(rankingResearchAllowed.externalFactPolicy.researchProhibited, false, "a newer explicit permission must lift no-search");

const malformedFallback = buildTaskContract({
  text: "修复新的代码问题",
  messages: [{ role: "assistant", record: { meta: { taskContract: { intentContract: "bad" } } } }],
});
assert.equal(malformedFallback.active, true, "malformed history must fail open to current baseline classification");
assert.equal(malformedFallback.intentContract.relation, "new");

const modelRefined = applyModelIntentCandidate(first.intentContract, {
  taskType: "general",
  objective: "在现有登录链路中修复重复提交，并交付可验证的回归结果",
  deliverables: ["regression_result"],
  successCriteria: ["duplicate_submit_reproduced_and_fixed"],
  constraints: ["do_not_replace_existing_login_stack"],
  assumptions: ["the existing login stack remains authoritative"],
  criticalUnknowns: [],
  neededCapabilities: ["browser_qa"],
  riskLevel: "low",
});
assert.equal(modelRefined.taskType, first.intentContract.taskType, "model refinement cannot reroute the host task type");
assert.equal(modelRefined.contractId, first.intentContract.contractId, "model refinement cannot replace host identity");
assert(modelRefined.deliverables.includes(first.intentContract.deliverables[0]), "model refinement cannot delete baseline deliverables");
assert(modelRefined.successCriteria.includes(first.intentContract.successCriteria[0]), "model refinement cannot delete baseline criteria");
assert(modelRefined.successCriteria.includes("duplicate_submit_reproduced_and_fixed"));
assert.equal(modelRefined.provenance.mode, "model_refined");

const baselineUnknown = {
  ...first.intentContract,
  criticalUnknowns: ["target_environment"],
};
const refinedUnknown = applyModelIntentCandidate(baselineUnknown, {
  taskType: "general",
  objective: baselineUnknown.objective,
  criticalUnknowns: [],
});
assert(refinedUnknown.criticalUnknowns.includes("target_environment"), "model refinement cannot silently delete host critical unknowns");

console.log("intent-contract: ok");
