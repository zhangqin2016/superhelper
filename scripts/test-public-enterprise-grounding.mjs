#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { evaluateAnswerEvidence, shouldBufferAssistantAnswer } = require("../src/main/answer-evidence-finalizer.js");
const { buildTaskContract, withTaskContractPrefix } = require("../src/main/task-contract.js");
const { buildTurnPolicy } = require("../src/main/turn-policy.js");

const ambiguousUserText = "中国有哪些建筑公司是副部级别";
const ambiguousContract = buildTaskContract({ text: ambiguousUserText });
const ambiguousPolicy = buildTurnPolicy({ text: ambiguousUserText, taskContract: ambiguousContract });

assert.equal(ambiguousContract.active, true);
assert.equal(ambiguousContract.taskType, "external_fact");
assert(ambiguousContract.externalFactPolicy.reasonCodes.includes("organization_status"));
assert(ambiguousContract.externalFactPolicy.reasonCodes.includes("regulated_classification"));
assert.equal(ambiguousContract.externalFactPolicy.scopeClarificationRequired, false);
assert.equal(ambiguousContract.externalFactPolicy.scopeDisclosureRequired, true);
assert.equal(ambiguousContract.externalFactPolicy.verificationPlan.scopeResolutionMode, "assume_and_disclose");
assert.equal(ambiguousContract.externalFactPolicy.sourceAuthority, "official_primary");
assert.equal(ambiguousContract.externalFactPolicy.verificationPlan.authorityUrlPolicy, "government");
assert.match(withTaskContractPrefix(ambiguousUserText, ambiguousContract), /authority_url_policy: government/);
assert(ambiguousContract.externalFactPolicy.finalAnswerRequirements.some((item) =>
  /Start with the responsible authority's official domain/.test(item)));
assert.equal(ambiguousContract.externalFactPolicy.verificationPlan.entityEvidenceRequired, true);
assert(ambiguousContract.externalFactPolicy.verificationPlan.forbiddenInferenceIds.includes(
  "ordered_directory_implies_classification",
));
assert.equal(shouldBufferAssistantAnswer(ambiguousContract), true);

const unverifiedAmbiguousAnswer = evaluateAnswerEvidence({
  assistant: "副部级建筑央企仅有中国建筑集团有限公司。",
  taskContract: ambiguousContract,
  turnPolicy: ambiguousPolicy,
  evidenceSummary: { hasFreshEvidence: false, hasDocumentEvidence: false, counts: {} },
  userText: ambiguousUserText,
});
assert.equal(unverifiedAmbiguousAnswer.assessment.reason, "missing_required_evidence:external");
assert.match(unverifiedAmbiguousAnswer.assistant, /没有取得可核验的实时来源/);
assert.doesNotMatch(unverifiedAmbiguousAnswer.assistant, /中国建筑集团/);
assert.equal(unverifiedAmbiguousAnswer.triggerVerifyRetry, true);

const avoidableClarification = evaluateAnswerEvidence({
  assistant: "副部级建筑央企仅有中国建筑集团有限公司。你是问一级央企还是也包括二级子公司？",
  taskContract: ambiguousContract,
  turnPolicy: ambiguousPolicy,
  evidenceSummary: { hasFreshEvidence: false, hasDocumentEvidence: false, counts: {} },
  userText: ambiguousUserText,
});
assert.equal(avoidableClarification.assessment.reason, "missing_required_evidence:external");
assert.doesNotMatch(avoidableClarification.assistant, /一级央企还是/);
assert.equal(avoidableClarification.triggerVerifyRetry, true);

const scopedUserText = "按国务院国资委直接监管的一级中央企业、并以领导人员干部管理权限为口径，哪些建筑类企业通常被称为副部级？";
const scopedContract = buildTaskContract({ text: scopedUserText });
const scopedPolicy = buildTurnPolicy({ text: scopedUserText, taskContract: scopedContract });
assert.equal(scopedContract.taskType, "external_fact");
assert.equal(scopedContract.externalFactPolicy.scopeClarificationRequired, false);
assert.equal(scopedContract.externalFactPolicy.scopeDisclosureRequired, false);
assert.equal(scopedContract.externalFactPolicy.sourceAuthority, "official_primary");

function freshEvidenceSummary() {
  return { hasFreshEvidence: true, hasDocumentEvidence: false, counts: { webSources: 1 } };
}

const secondaryUrl = "https://example.com/building-soe-list";
const secondaryOnly = evaluateAnswerEvidence({
  assistant: `中国建筑集团有限公司通常被称为副部级央企。\n${secondaryUrl}`,
  taskContract: scopedContract,
  turnPolicy: scopedPolicy,
  evidenceSummary: freshEvidenceSummary(),
  tools: [{
    name: "Bash",
    input: { command: String.raw`echo '{"query":"building company classification"}' | "C:\runtime-bin\node.cmd" "C:\skills\websearch\scripts\websearch.cjs"` },
    result: `中国建筑集团有限公司通常被称为副部级央企。 ${secondaryUrl}`,
  }],
  userText: scopedUserText,
});
assert.equal(secondaryOnly.assessment.reason, "authoritative_source_required");
assert.match(secondaryOnly.assistant, /负责认定或监管机构的一手材料/);
assert.equal(secondaryOnly.triggerVerifyRetry, true);

const directoryUrl = "https://www.sasac.gov.cn/n2588045/n27271785/index.html";
const directoryInference = evaluateAnswerEvidence({
  assistant: `国资委名录前54家属于副部级，因此中国建筑集团有限公司是副部级央企。\n${directoryUrl}`,
  taskContract: scopedContract,
  turnPolicy: scopedPolicy,
  evidenceSummary: freshEvidenceSummary(),
  tools: [{ result: `国资委中央企业名录，中国建筑集团有限公司。 ${directoryUrl}` }],
  userText: scopedUserText,
});
assert.equal(directoryInference.assessment.reason, "forbidden_inference:ordered_directory_implies_classification");

const officialDirectoryOnly = evaluateAnswerEvidence({
  assistant: `先说明中国建筑集团有限公司是本题涉及的企业。\n副部级央企：\n中国建筑集团有限公司\n${directoryUrl}`,
  taskContract: scopedContract,
  turnPolicy: scopedPolicy,
  evidenceSummary: freshEvidenceSummary(),
  tools: [{ result: `国资委中央企业名录包含中国建筑集团有限公司。 ${directoryUrl}` }],
  userText: scopedUserText,
});
assert.equal(officialDirectoryOnly.assessment.reason, "entity_claim_not_in_evidence");
assert.deepEqual(officialDirectoryOnly.assessment.entityCoverage.unsupportedClassificationClaims, ["中国建筑集团有限公司"]);

const appointmentEvidence = [
  "中共中央决定，中国建筑集团有限公司主要负责人职务调整。",
  directoryUrl,
].join("\n");
const assumedScopeAnswer = evaluateAnswerEvidence({
  assistant: `按国务院国资委直接监管的一级中央企业、并以领导人员干部管理权限为核验口径，中国建筑集团有限公司符合通常所称的中管企业口径。\n${directoryUrl}`,
  taskContract: ambiguousContract,
  turnPolicy: ambiguousPolicy,
  evidenceSummary: freshEvidenceSummary(),
  tools: [{ result: appointmentEvidence }],
  userText: ambiguousUserText,
});
assert.equal(assumedScopeAnswer.assessment.ok, true, "an ambiguous reversible query must be answerable in one turn with a disclosed scope and evidence");

const supportedCadreInference = evaluateAnswerEvidence({
  assistant: `按约定的干部管理口径，官方材料显示中国建筑集团有限公司主要负责人任免由中共中央决定，因此可作为通常所称的中管企业理解。\n${directoryUrl}`,
  taskContract: scopedContract,
  turnPolicy: scopedPolicy,
  evidenceSummary: freshEvidenceSummary(),
  tools: [{ result: appointmentEvidence }],
  userText: scopedUserText,
});
assert.equal(supportedCadreInference.assessment.ok, true);

const mergerUrl = "https://wap.sasac.gov.cn/n2588045/n27271785/n27271802/c14159379/content.html";
const mergerEvidence = [
  "中国冶金科工集团有限公司整体并入中国五矿集团有限公司，成为其全资子企业，不再作为国资委直接监管企业。",
  mergerUrl,
].join("\n");
const conflictingRoster = evaluateAnswerEvidence({
  assistant: `正厅级建筑央企：\n中国冶金科工集团有限公司\n${mergerUrl}`,
  taskContract: scopedContract,
  turnPolicy: scopedPolicy,
  evidenceSummary: freshEvidenceSummary(),
  tools: [{ result: mergerEvidence }],
  userText: scopedUserText,
});
assert.equal(conflictingRoster.assessment.reason, "entity_claim_conflicts_with_evidence");
assert.deepEqual(conflictingRoster.assessment.conflictingClaims, ["中国冶金科工集团有限公司"]);
assert.doesNotMatch(conflictingRoster.assistant, /正厅级建筑央企/);

const groundedAnswer = [
  "企业本身原则上不再套用行政级别，不能仅凭名录序号推导所谓级别。",
  "中国冶金科工集团有限公司已整体并入中国五矿集团有限公司，现为其全资子企业，不应列作国资委直接监管的一级央企。",
  mergerUrl,
].join("\n");
const grounded = evaluateAnswerEvidence({
  assistant: groundedAnswer,
  taskContract: scopedContract,
  turnPolicy: scopedPolicy,
  evidenceSummary: freshEvidenceSummary(),
  tools: [{ result: mergerEvidence }],
  userText: scopedUserText,
});
assert.equal(grounded.assessment.ok, true);
assert.equal(grounded.assistant, groundedAnswer);

const codingContract = buildTaskContract({ text: "为央企子公司开发一个项目管理系统并写代码" });
assert.equal(codingContract.taskType, "code_change");
assert.equal(codingContract.externalFactPolicy.required, false);

const internalContract = buildTaskContract({ text: "我们公司有哪些子公司" });
assert.equal(internalContract.externalFactPolicy.required, false);

console.log("public-enterprise-grounding: ok");
