#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { evaluateAnswerEvidence } = require("../src/main/answer-evidence-finalizer.js");
const { buildTaskContract } = require("../src/main/task-contract.js");
const { buildTurnPolicy } = require("../src/main/turn-policy.js");

function freshEvidenceSummary() {
  return { hasFreshEvidence: true, hasDocumentEvidence: false, counts: { webSources: 1 } };
}

function evaluate({ userText, assistant, evidence }) {
  const taskContract = buildTaskContract({ text: userText });
  return {
    taskContract,
    result: evaluateAnswerEvidence({
      assistant,
      taskContract,
      turnPolicy: buildTurnPolicy({ text: userText, taskContract }),
      evidenceSummary: freshEvidenceSummary(),
      tools: [{ result: evidence }],
      userText,
    }),
  };
}

const hospitalQuestion = "中国有哪些三甲医院？";
const hospitalContract = buildTaskContract({ text: hospitalQuestion });
assert.equal(hospitalContract.taskType, "external_fact");
assert(hospitalContract.externalFactPolicy.verificationPlan.profileIds.includes(
  "regulated_organization_classification",
));
assert.equal(hospitalContract.externalFactPolicy.scopeClarificationRequired, false);
assert.equal(hospitalContract.externalFactPolicy.sourceAuthority, "official_primary");
assert.equal(hospitalContract.externalFactPolicy.verificationPlan.entityEvidenceRequired, true);

const healthAuthorityUrl = "https://wjw.example.gov.cn/hospital/grade-a";
const groundedHospital = evaluate({
  userText: hospitalQuestion,
  assistant: `三级甲等医院：\n示例市人民医院\n${healthAuthorityUrl}`,
  evidence: `示例市人民医院被评定为三级甲等医院。\n${healthAuthorityUrl}`,
});
assert.equal(groundedHospital.result.assessment.ok, true);

const secondaryHospitalUrl = "https://example.com/hospital-list";
const secondaryHospital = evaluate({
  userText: hospitalQuestion,
  assistant: `三级甲等医院：\n示例市人民医院\n${secondaryHospitalUrl}`,
  evidence: `示例市人民医院被评定为三级甲等医院。\n${secondaryHospitalUrl}`,
});
assert.equal(secondaryHospital.result.assessment.reason, "authoritative_source_required");

const revokedHospital = evaluate({
  userText: hospitalQuestion,
  assistant: `三级甲等医院：\n示例市人民医院\n${healthAuthorityUrl}`,
  evidence: `示例市人民医院的三级甲等医院资格已撤销。\n${healthAuthorityUrl}`,
});
assert.equal(revokedHospital.result.assessment.reason, "entity_claim_conflicts_with_evidence");
assert.deepEqual(revokedHospital.result.assessment.conflictingClaims, ["示例市人民医院"]);

const neighboringRevocation = evaluate({
  userText: hospitalQuestion,
  assistant: `三级甲等医院：\n示例市人民医院\n${healthAuthorityUrl}`,
  evidence: `示例市人民医院被评定为三级甲等医院。另一所人民医院的三级甲等资格已撤销。\n${healthAuthorityUrl}`,
});
assert.equal(neighboringRevocation.result.assessment.ok, true);

const affiliationQuestion = "OpenAI 隶属于哪家公司？";
const affiliationContract = buildTaskContract({ text: affiliationQuestion });
assert.equal(affiliationContract.taskType, "external_fact");
assert(affiliationContract.externalFactPolicy.verificationPlan.profileIds.includes("organization_relationship"));
assert.equal(affiliationContract.externalFactPolicy.sourceAuthority, "primary_or_official");

const companyUrl = "https://example.com/about";
const groundedAffiliation = evaluate({
  userText: affiliationQuestion,
  assistant: `OpenAI 隶属于 Example Holdings。\n${companyUrl}`,
  evidence: `OpenAI 隶属于 Example Holdings。\n${companyUrl}`,
});
assert.equal(groundedAffiliation.result.assessment.ok, true);

const inventedAffiliation = evaluate({
  userText: affiliationQuestion,
  assistant: `OpenAI 隶属于 Imaginary Holdings。\n${companyUrl}`,
  evidence: `OpenAI 隶属于 Example Holdings。\n${companyUrl}`,
});
assert.equal(inventedAffiliation.result.assessment.reason, "entity_claim_not_in_evidence");
assert(inventedAffiliation.result.assessment.unsupportedClaims.includes("Imaginary Holdings"));

const accreditationContract = buildTaskContract({ text: "Which universities are officially accredited?" });
assert(accreditationContract.externalFactPolicy.verificationPlan.profileIds.includes(
  "regulated_organization_classification",
));
assert.equal(accreditationContract.externalFactPolicy.sourceAuthority, "official_primary");

const rankingContract = buildTaskContract({ text: "请给全球大学 Top 3 排行" });
assert.equal(rankingContract.taskType, "external_fact");
assert(rankingContract.externalFactPolicy.verificationPlan.profileIds.includes("comparative_ranking"));
assert.equal(rankingContract.externalFactPolicy.sourceAuthority, "named_publisher");
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
