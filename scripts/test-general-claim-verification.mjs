#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { evaluateAnswerEvidence, evaluateAnswerEvidenceWithJudge } = require("../src/main/answer-evidence-finalizer.js");
const { normalizeVerificationPlan } = require("../src/main/external-claim-profiles.js");
const { buildExternalFactPolicy } = require("../src/main/external-fact-policy.js");
const { buildTaskContract } = require("../src/main/task-contract.js");
const { withExternalFactPolicy } = require("../src/main/task-evidence-policy.js");
const { buildTurnPolicy } = require("../src/main/turn-policy.js");

// The turn-start detector no longer carries domain profiles: semantics arrive
// via the model's verification-plan candidate. This helper applies exactly
// what model-turn-contract-refinement does in production.
function activateWithModelPlan(contract, plan = {}) {
  const externalFact = buildExternalFactPolicy({
    active: true,
    reasonCodes: ["model_external_fact"],
    requiresFreshness: true,
    requiresSourceLinks: true,
    verificationPlan: normalizeVerificationPlan({ profileIds: ["model_semantic_claim"], ...plan }),
  });
  contract.externalFactPolicy = externalFact;
  contract.evidencePolicy = withExternalFactPolicy(contract.evidencePolicy, externalFact);
  return contract;
}

function freshEvidenceSummary() {
  return { hasFreshEvidence: true, hasDocumentEvidence: false, counts: { webSources: 1 } };
}

function verdict({ supported = [], unsupported = [], urls = [], conflicts = [], informalLabel = false, framingNote = "", stakes = "low" } = {}) {
  return {
    supportedClaims: supported,
    unsupportedClaims: unsupported,
    authoritativeUrls: urls,
    conflictingClaims: conflicts,
    informalLabel,
    framingNote,
    stakes,
  };
}

// Semantic outcomes (support, conflict, authority) are ruled by the turn
// judge — tests inject the verdict; the literal floor (presence, windows,
// citation grounding) stays deterministic.
async function evaluate({ userText, assistant, evidence, judgeVerdict = null, plan = null }) {
  const taskContract = buildTaskContract({ text: userText });
  if (plan) activateWithModelPlan(taskContract, plan);
  const params = {
    assistant,
    taskContract,
    turnPolicy: buildTurnPolicy({ text: userText, taskContract }),
    evidenceSummary: freshEvidenceSummary(),
    tools: [{ result: evidence }],
    userText,
  };
  if (!judgeVerdict) {
    return { taskContract, result: evaluateAnswerEvidence(params) };
  }
  return {
    taskContract,
    result: await evaluateAnswerEvidenceWithJudge(params, { judge: async () => judgeVerdict }),
  };
}

const hospitalQuestion = "中国有哪些三甲医院？";
const hospitalContract = buildTaskContract({ text: hospitalQuestion });
assert.equal(hospitalContract.externalFactPolicy.required, false, "turn-start detection is domain-blind; the model declares the semantics");
activateWithModelPlan(hospitalContract, { entityEvidenceRequired: true, classificationEvidenceRequired: true });
assert(hospitalContract.externalFactPolicy.verificationPlan.profileIds.includes("model_semantic_claim"));
assert.equal(hospitalContract.externalFactPolicy.scopeClarificationRequired, false);
assert.equal(hospitalContract.externalFactPolicy.verificationPlan.entityEvidenceRequired, true);

const hospitalPlan = { entityEvidenceRequired: true, classificationEvidenceRequired: true };
const healthAuthorityUrl = "https://wjw.example.gov.cn/hospital/grade-a";
const groundedHospital = await evaluate({
  userText: hospitalQuestion,
  assistant: `三级甲等医院：\n示例市人民医院\n${healthAuthorityUrl}`,
  evidence: `示例市人民医院被评定为三级甲等医院。\n${healthAuthorityUrl}`,
  judgeVerdict: verdict({ supported: ["示例市人民医院"], urls: [healthAuthorityUrl] }),
  plan: hospitalPlan,
});
assert.equal(groundedHospital.result.assessment.ok, true);
assert.equal(groundedHospital.result.assessment.semanticJudged, true);

const secondaryHospitalUrl = "https://example.com/hospital-list";
const secondaryHospital = await evaluate({
  userText: hospitalQuestion,
  assistant: `三级甲等医院：\n示例市人民医院\n${secondaryHospitalUrl}`,
  evidence: `示例市人民医院被评定为三级甲等医院。\n${secondaryHospitalUrl}`,
  plan: hospitalPlan,
});
assert.equal(secondaryHospital.result.assessment.ok, false);
assert(
  ["authoritative_source_required", "semantic_support_unverified"].includes(secondaryHospital.result.assessment.reason),
  `secondary material cannot clear the gate without the judge: ${secondaryHospital.result.assessment.reason}`,
);

const revokedHospital = await evaluate({
  userText: hospitalQuestion,
  assistant: `三级甲等医院：\n示例市人民医院\n${healthAuthorityUrl}`,
  evidence: `示例市人民医院的三级甲等医院资格已撤销。\n${healthAuthorityUrl}`,
  judgeVerdict: verdict({ supported: [], urls: [healthAuthorityUrl], conflicts: ["示例市人民医院"] }),
  plan: hospitalPlan,
});
assert.equal(revokedHospital.result.assessment.reason, "entity_claim_conflicts_with_evidence");
assert.deepEqual(revokedHospital.result.assessment.conflictingClaims, ["示例市人民医院"]);
assert.doesNotMatch(revokedHospital.result.assistant, /示例市人民医院/, "judge-ruled conflicts are never banner-kept");

const neighboringRevocation = await evaluate({
  userText: hospitalQuestion,
  assistant: `三级甲等医院：\n示例市人民医院\n${healthAuthorityUrl}`,
  evidence: `示例市人民医院被评定为三级甲等医院。另一所人民医院的三级甲等资格已撤销。\n${healthAuthorityUrl}`,
  judgeVerdict: verdict({ supported: ["示例市人民医院"], urls: [healthAuthorityUrl] }),
  plan: hospitalPlan,
});
assert.equal(neighboringRevocation.result.assessment.ok, true);

const affiliationQuestion = "OpenAI 隶属于哪家公司？";
const affiliationContract = buildTaskContract({ text: affiliationQuestion });
assert.equal(affiliationContract.externalFactPolicy.required, false, "affiliation is semantic — the turn-start detector stays silent");
const affiliationPlan = { entityEvidenceRequired: true };

const companyUrl = "https://example.com/about";
const groundedAffiliation = await evaluate({
  userText: affiliationQuestion,
  assistant: `OpenAI 隶属于 Example Holdings。\n${companyUrl}`,
  evidence: `OpenAI 隶属于 Example Holdings。\n${companyUrl}`,
  judgeVerdict: verdict({ supported: ["OpenAI", "Example Holdings"] }),
  plan: affiliationPlan,
});
assert.equal(groundedAffiliation.result.assessment.ok, true);

const inventedAffiliation = await evaluate({
  userText: affiliationQuestion,
  assistant: `OpenAI 隶属于 Imaginary Holdings。\n${companyUrl}`,
  evidence: `OpenAI 隶属于 Example Holdings。\n${companyUrl}`,
  plan: affiliationPlan,
});
assert.equal(inventedAffiliation.result.assessment.reason, "entity_claim_not_in_evidence");
assert(inventedAffiliation.result.assessment.unsupportedClaims.includes("Imaginary Holdings"));

const accreditationContract = buildTaskContract({ text: "Which universities are officially accredited?" });
assert.equal(accreditationContract.externalFactPolicy.required, false, "accreditation is semantic — no regex profile fires");
activateWithModelPlan(accreditationContract, { entityEvidenceRequired: true, classificationEvidenceRequired: true });
assert.equal(accreditationContract.externalFactPolicy.verificationPlan.entityEvidenceRequired, true);

const rankingContract = buildTaskContract({ text: "请给全球大学 Top 3 排行" });
assert.equal(rankingContract.taskType, "external_fact");
assert(rankingContract.externalFactPolicy.reasonCodes.includes("ranking"), "ranking is a request-shape trigger and stays");
assert.deepEqual(rankingContract.externalFactPolicy.verificationPlan.profileIds, [], "no domain profiles at turn start");
assert.equal(rankingContract.externalFactPolicy.verificationPlan.authorityUrlPolicy, "none");

const codingContract = buildTaskContract({ text: "给三甲医院开发挂号系统并写代码" });
assert.equal(codingContract.taskType, "code_change");
assert.equal(codingContract.externalFactPolicy.required, false);

const unknownDomainText = "Who is the current CEO of Example Corp?";
const unknownDomainContract = buildTaskContract({ text: unknownDomainText });
unknownDomainContract.evidencePolicy.verificationPlan = {
  profileIds: "malformed-not-an-array",
  requiredScopeDimensions: 42,
};
const unknownDomainUrl = "https://example.com/leadership";
const unknownDomainResult = evaluateAnswerEvidence({
  assistant: `The current CEO is Jane Doe.\n${unknownDomainUrl}`,
  taskContract: unknownDomainContract,
  turnPolicy: buildTurnPolicy({ text: unknownDomainText, taskContract: unknownDomainContract }),
  evidenceSummary: freshEvidenceSummary(),
  tools: [{ result: `The current CEO is Jane Doe.\n${unknownDomainUrl}` }],
  userText: unknownDomainText,
});
assert.equal(unknownDomainResult.assessment.ok, true);
assert.equal(unknownDomainResult.error, undefined);

const productionSources = [
  "src/main/external-fact-policy.js",
  "src/main/external-claim-profiles.js",
  "src/main/external-claim-gate.js",
  "src/main/entity-claim-evidence.js",
  "src/main/evidence-gate.js",
].map((file) => fs.readFileSync(file, "utf8")).join("\n");
assert.doesNotMatch(productionSources, /中国建筑集团|中国冶金科工|中冶/);
assert.doesNotMatch(productionSources, /publicEnterprise|authoritativeGovernment|forbidDirectoryRank/);

console.log("general-claim-verification: ok");
