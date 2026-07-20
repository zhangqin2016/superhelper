#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { evaluateAnswerEvidence, evaluateAnswerEvidenceWithJudge } = require("../src/main/answer-evidence-finalizer.js");
const { normalizeVerificationPlan } = require("../src/main/external-claim-profiles.js");
const { buildExternalFactPolicy } = require("../src/main/external-fact-policy.js");
const { buildTaskContract, withTaskContractPrefix } = require("../src/main/task-contract.js");
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

const ambiguousUserText = "中国有哪些建筑公司是副部级别";
const ambiguousContract = buildTaskContract({ text: ambiguousUserText });

// Turn-start: "副部级" is not coded anywhere — the detector stays silent and
// waits for the model's own semantic declaration (or observed research).
assert.equal(ambiguousContract.externalFactPolicy.required, false, "no request-shape trigger: turn-start detection is domain-blind");
assert.deepEqual(ambiguousContract.externalFactPolicy.verificationPlan.profileIds, []);

// The model declares the semantics through its verification-plan candidate.
activateWithModelPlan(ambiguousContract, { entityEvidenceRequired: true, classificationEvidenceRequired: true });
const ambiguousPolicy = buildTurnPolicy({ text: ambiguousUserText, taskContract: ambiguousContract });
assert.equal(ambiguousContract.externalFactPolicy.required, true);
assert(ambiguousContract.externalFactPolicy.reasonCodes.includes("model_external_fact"));
assert.equal(ambiguousContract.externalFactPolicy.scopeClarificationRequired, false);
assert.equal(ambiguousContract.externalFactPolicy.verificationPlan.entityEvidenceRequired, true);
assert(ambiguousContract.externalFactPolicy.finalAnswerRequirements.some((item) =>
  /Map every named entity/.test(item)));
// Risk-tier contract: informal-label rosters are verify_soft — only genuinely
// high-stakes asks are hard-tier now. verify_soft answers keep streaming
// (failures route to a bounded banner, never a wholesale swap).
const { shouldBufferAssistantAnswer } = require("../src/main/answer-evidence-finalizer.js");
assert.equal(shouldBufferAssistantAnswer(ambiguousContract), false, "ordinary roster asks stream; only hard tier buffers");

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
assert.equal(scopedContract.externalFactPolicy.required, false, "a scoped informal-label question is still domain-invisible at turn start");
activateWithModelPlan(scopedContract, {
  entityEvidenceRequired: true,
  classificationEvidenceRequired: true,
  sourceAuthority: "official_primary", // model-declared authority tier → judge-ruled adequacy
});
const scopedPolicy = buildTurnPolicy({ text: scopedUserText, taskContract: scopedContract });
assert.equal(scopedContract.externalFactPolicy.required, true);
assert.equal(scopedContract.externalFactPolicy.scopeClarificationRequired, false);

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

// ---------------------------------------------------------------------------
// Model-first gate: source authority is a JUDGE call, not a gov-TLD regex.
// Secondary-only sourcing stays unverified — but ordinary asks fail OPEN with
// a bounded banner answer instead of the old zero-content refusal.
const secondaryUrl = "https://example.com/building-soe-list";
const secondaryOnly = await evaluateAnswerEvidenceWithJudge({
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
}, {
  judge: async () => verdict({
    supported: ["中国建筑集团有限公司"],
    urls: [], // judge: the aggregator is NOT an authoritative channel
    informalLabel: true,
    framingNote: "副部级是行业俗称,并非官方正式认定。",
  }),
});
assert.equal(secondaryOnly.assessment.reason, "authoritative_source_required");
assert.equal(secondaryOnly.assessment.semanticJudged, true);
assert.equal(secondaryOnly.assessment.framedBounded, true);
assert.match(secondaryOnly.assistant, /⚠️/);
assert.match(secondaryOnly.assistant, /中国建筑集团有限公司/);
assert.doesNotMatch(secondaryOnly.assistant, /负责认定或监管机构的一手材料/);
assert.equal(secondaryOnly.triggerVerifyRetry, true);

// A directory-order derivation is no longer a REGEX-forbidden inference — the
// judge rules whether the excerpt entails the claim. When it does (and the
// source is authoritative), the answer passes WITH the informal-label framing.
const directoryUrl = "https://www.sasac.gov.cn/n2588045/n27271785/index.html";
const directoryInference = await evaluateAnswerEvidenceWithJudge({
  assistant: `国资委名录前54家属于副部级，因此中国建筑集团有限公司是副部级央企。\n${directoryUrl}`,
  taskContract: scopedContract,
  turnPolicy: scopedPolicy,
  evidenceSummary: freshEvidenceSummary(),
  tools: [{ result: `国资委中央企业名录，中国建筑集团有限公司。 ${directoryUrl}` }],
  userText: scopedUserText,
}, {
  judge: async ({ urls }) => verdict({
    supported: ["中国建筑集团有限公司"],
    urls,
    informalLabel: true,
    framingNote: "副部级是行业对中管企业的俗称,依据是央企名录范围与任免权限,并非官方正式认定。",
  }),
});
assert.equal(directoryInference.assessment.ok, true);
assert.equal(directoryInference.assessment.informalLabelFramed, true);
assert.match(directoryInference.assistant, /口径说明/);
assert.match(directoryInference.assistant, /中国建筑集团有限公司/);

// Judge rules the excerpt does NOT entail the assertion (mere directory
// presence): ordinary fail-open keeps the windowed claim under a banner.
const officialDirectoryOnly = await evaluateAnswerEvidenceWithJudge({
  assistant: `先说明中国建筑集团有限公司是本题涉及的企业。\n副部级央企：\n中国建筑集团有限公司\n${directoryUrl}`,
  taskContract: scopedContract,
  turnPolicy: scopedPolicy,
  evidenceSummary: freshEvidenceSummary(),
  tools: [{ result: `国资委中央企业名录包含中国建筑集团有限公司。 ${directoryUrl}` }],
  userText: scopedUserText,
}, {
  judge: async ({ urls }) => verdict({
    supported: [],
    unsupported: ["中国建筑集团有限公司"],
    urls,
    informalLabel: true,
  }),
});
assert.equal(officialDirectoryOnly.assessment.ok, false);
assert.equal(officialDirectoryOnly.assessment.semanticJudged, true);
assert.match(officialDirectoryOnly.assistant, /⚠️/);
assert.match(officialDirectoryOnly.assistant, /中国建筑集团有限公司/);

const appointmentEvidence = [
  "中共中央决定，中国建筑集团有限公司主要负责人职务调整。",
  directoryUrl,
].join("\n");
const assumedScopeAnswer = await evaluateAnswerEvidenceWithJudge({
  assistant: `按国务院国资委直接监管的一级中央企业、并以领导人员干部管理权限为核验口径，中国建筑集团有限公司符合通常所称的中管企业口径。\n${directoryUrl}`,
  taskContract: ambiguousContract,
  turnPolicy: ambiguousPolicy,
  evidenceSummary: freshEvidenceSummary(),
  tools: [{ result: appointmentEvidence }],
  userText: ambiguousUserText,
}, {
  judge: async ({ urls }) => verdict({
    supported: ["中国建筑集团有限公司"],
    urls,
    informalLabel: true,
    framingNote: "副部级是行业对中管企业的俗称。",
  }),
});
assert.equal(assumedScopeAnswer.assessment.ok, true, "an ambiguous reversible query must be answerable in one turn with a disclosed scope and evidence");
assert.match(assumedScopeAnswer.assistant, /中国建筑集团有限公司/);

// Judge-ruled CONFLICT (the entity was merged into another group): never
// banner-kept, never salvage-kept — the fail-closed remainder applies.
const mergerUrl = "https://wap.sasac.gov.cn/n2588045/n27271785/n27271802/c14159379/content.html";
const mergerEvidence = [
  "中国冶金科工集团有限公司整体并入中国五矿集团有限公司，成为其全资子企业，不再作为国资委直接监管企业。",
  mergerUrl,
].join("\n");
const conflictingRoster = await evaluateAnswerEvidenceWithJudge({
  assistant: `正厅级建筑央企：\n中国冶金科工集团有限公司\n${mergerUrl}`,
  taskContract: scopedContract,
  turnPolicy: scopedPolicy,
  evidenceSummary: freshEvidenceSummary(),
  tools: [{ result: mergerEvidence }],
  userText: scopedUserText,
}, {
  judge: async ({ urls }) => verdict({
    supported: [],
    unsupported: [],
    urls,
    conflicts: ["中国冶金科工集团有限公司"],
  }),
});
assert.equal(conflictingRoster.assessment.reason, "entity_claim_conflicts_with_evidence");
assert.deepEqual(conflictingRoster.assessment.conflictingClaims, ["中国冶金科工集团有限公司"]);
assert.doesNotMatch(conflictingRoster.assistant, /正厅级建筑央企/);

const groundedAnswer = [
  "企业本身原则上不再套用行政级别，不能仅凭名录序号推导所谓级别。",
  "中国冶金科工集团有限公司已整体并入中国五矿集团有限公司，现为其全资子企业，不应列作国资委直接监管的一级央企。",
  mergerUrl,
].join("\n");
const grounded = await evaluateAnswerEvidenceWithJudge({
  assistant: groundedAnswer,
  taskContract: scopedContract,
  turnPolicy: scopedPolicy,
  evidenceSummary: freshEvidenceSummary(),
  tools: [{ result: mergerEvidence }],
  userText: scopedUserText,
}, {
  judge: async ({ urls }) => verdict({
    supported: ["中国冶金科工集团有限公司", "中国五矿集团有限公司"],
    urls,
  }),
});
assert.equal(grounded.assessment.ok, true);
assert.match(grounded.assistant, /中国冶金科工集团有限公司/);

const codingContract = buildTaskContract({ text: "为央企子公司开发一个项目管理系统并写代码" });
assert.equal(codingContract.taskType, "code_change");
assert.equal(codingContract.externalFactPolicy.required, false);

const internalContract = buildTaskContract({ text: "我们公司有哪些子公司" });
assert.equal(internalContract.externalFactPolicy.required, false);

console.log("public-enterprise-grounding: ok");
