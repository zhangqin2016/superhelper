#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { evaluateAnswerEvidence } = require("../src/main/answer-evidence-finalizer.js");
const { findBrokerTool } = require("../src/main/mcp/tool-broker-registry.js");
const { applyModelTurnContractRefinement } = require("../src/main/model-turn-contract-refinement.js");
const { buildTaskContract } = require("../src/main/task-contract.js");
const { buildTurnPolicy } = require("../src/main/turn-policy.js");

const intentTool = findBrokerTool({ sessionId: "s1", activeSkillIds: [] }, "lily_intent_contract_commit");
assert(intentTool);
const candidateResult = await intentTool.handler({
  objective: "Identify the current leader with verified evidence",
  verificationPlan: {
    claimKinds: ["current_status"],
    requiredScopeDimensions: ["as_of_date"],
    resolvedScopeDimensions: ["as_of_date"],
    sourceAuthority: "official_primary",
    entityEvidenceRequired: true,
  },
});
assert.equal(candidateResult.verificationPlan.sourceAuthority, "official_primary");

const unknownDomainContract = buildTaskContract({ text: "Who is the current CEO of Example Corp?" });
assert.equal(unknownDomainContract.taskType, "external_fact");
assert.deepEqual(unknownDomainContract.externalFactPolicy.verificationPlan.profileIds, []);
const refinement = applyModelTurnContractRefinement({
  taskContract: unknownDomainContract,
  toolResult: candidateResult,
});
assert.equal(refinement.intentContractRefined, true);
assert.equal(refinement.verificationPlanRefined, true);
assert(unknownDomainContract.externalFactPolicy.verificationPlan.profileIds.includes("model_semantic_claim"));
assert(unknownDomainContract.externalFactPolicy.verificationPlan.claimKinds.includes("current_status"));
assert.equal(unknownDomainContract.externalFactPolicy.sourceAuthority, "official_primary");
assert.equal(unknownDomainContract.evidencePolicy.sourceAuthority, "official_primary");
assert.equal(unknownDomainContract.evidencePolicy.entityEvidenceRequired, true);
assert.equal(unknownDomainContract.externalFactPolicy.scopeClarificationRequired, false);

const unresolvedContract = buildTaskContract({ text: "Who is the current CEO of Example Corp?" });
applyModelTurnContractRefinement({
  taskContract: unresolvedContract,
  toolResult: {
    intentContract: { objective: "identify the current leader" },
    verificationPlan: {
      claimKinds: ["current_status"],
      requiredScopeDimensions: ["as_of_date"],
      sourceAuthority: "official_primary",
    },
  },
});
const unresolvedAnswer = evaluateAnswerEvidence({
  assistant: "The current CEO is Jane Doe.",
  taskContract: unresolvedContract,
  turnPolicy: buildTurnPolicy({ text: "Who is the current CEO of Example Corp?", taskContract: unresolvedContract }),
  evidenceSummary: { hasFreshEvidence: false, counts: {} },
  userText: "Who is the current CEO of Example Corp?",
});
assert.equal(unresolvedContract.externalFactPolicy.scopeClarificationRequired, false);
assert.equal(unresolvedContract.externalFactPolicy.scopeDisclosureRequired, true);
assert.equal(unresolvedAnswer.assessment.reason, "missing_required_evidence:external");
assert.match(unresolvedAnswer.assistant, /did not obtain a verifiable current source/i);
assert.doesNotMatch(unresolvedAnswer.assistant, /coding quality/i);
assert.equal(unresolvedAnswer.triggerVerifyRetry, true);

const genuinelyBlockedContract = buildTaskContract({ text: "Who is the current CEO of Example Corp?" });
applyModelTurnContractRefinement({
  taskContract: genuinelyBlockedContract,
  toolResult: {
    intentContract: {
      objective: "identify the current leader",
      criticalUnknowns: ["The user has not identified which regional entity named Example Corp is intended."],
    },
  },
});
assert.equal(genuinelyBlockedContract.evidencePolicy.allowClarificationWithoutEvidence, true);
const necessaryClarification = evaluateAnswerEvidence({
  assistant: "Which country or market's Example Corp do you mean?",
  taskContract: genuinelyBlockedContract,
  turnPolicy: buildTurnPolicy({ text: "Who is the current CEO of Example Corp?", taskContract: genuinelyBlockedContract }),
  evidenceSummary: { hasFreshEvidence: false, counts: {} },
  userText: "Who is the current CEO of Example Corp?",
});
assert.equal(necessaryClarification.assessment.ok, true);
assert.equal(necessaryClarification.assessment.clarification, true);

const deterministicContract = buildTaskContract({ text: "中国有哪些建筑公司是副部级别" });
const attemptedWeakening = {
  intentContract: {
    objective: "answer the classification question",
  },
  verificationPlan: {
    claimKinds: ["classification"],
    resolvedScopeDimensions: ["entity_population", "classification_basis"],
    sourceAuthority: "standard",
    entityEvidenceRequired: false,
    classificationEvidenceRequired: false,
  },
};
applyModelTurnContractRefinement({ taskContract: deterministicContract, toolResult: attemptedWeakening });
assert.equal(deterministicContract.externalFactPolicy.scopeClarificationRequired, false);
assert.equal(deterministicContract.externalFactPolicy.scopeDisclosureRequired, true);
assert.equal(deterministicContract.externalFactPolicy.sourceAuthority, "official_primary");
assert.equal(deterministicContract.externalFactPolicy.verificationPlan.entityEvidenceRequired, true);
assert.equal(deterministicContract.externalFactPolicy.verificationPlan.classificationEvidenceRequired, true);
assert.deepEqual(deterministicContract.externalFactPolicy.verificationPlan.resolvedScopeDimensions, []);

const localCodeContract = buildTaskContract({ text: "开发一个库存管理程序并写测试" });
const localPlanBefore = localCodeContract.externalFactPolicy.verificationPlan;
applyModelTurnContractRefinement({ taskContract: localCodeContract, toolResult: candidateResult });
assert.equal(localCodeContract.externalFactPolicy.required, false);
assert.deepEqual(localCodeContract.externalFactPolicy.verificationPlan, localPlanBefore);

const malformedContract = buildTaskContract({ text: "Who is the current CEO of Example Corp?" });
const malformed = applyModelTurnContractRefinement({
  taskContract: malformedContract,
  toolResult: "not-json",
});
assert.equal(malformed, null);
assert.deepEqual(malformedContract.externalFactPolicy.verificationPlan.profileIds, []);

console.log("model-verification-plan: ok");
