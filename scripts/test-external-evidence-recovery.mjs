#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildEvidenceRecoveryHint,
  initialResearchRequirements,
} = require("../src/main/external-evidence-recovery.js");
const {
  applyInternalRecoveryLayer,
  buildEvidenceRecoveryContext,
  initializeTurnEvidenceState,
  isInternalRecoveryPromptText,
  restoreEvidenceRecoveryContext,
} = require("../src/main/turn-recovery-context.js");
const { evaluateAnswerEvidence, evaluateAnswerEvidenceWithJudge } = require("../src/main/answer-evidence-finalizer.js");
const { extractLayerText, extractUserOriginalRequest } = require("../src/main/engine-message-layers.js");
const { buildTaskContract, withTaskContractPrefix } = require("../src/main/task-contract.js");
const { buildTurnPolicy } = require("../src/main/turn-policy.js");

const classificationPlan = {
  claimKinds: ["classification"],
  sourceAuthority: "official_primary",
  entityEvidenceRequired: true,
  classificationEvidenceRequired: true,
};
const requirements = initialResearchRequirements(classificationPlan).join("\n");
assert.match(requirements, /broad search only to discover/i);
assert.match(requirements, /whether the requested label is a formal classification/i);
assert.match(requirements, /supported subset/i);

const recovery = buildEvidenceRecoveryHint({
  language: "zh",
  reason: "authoritative_source_required",
  verificationPlan: classificationPlan,
  evidenceSummary: {
    events: [
      { kind: "web_search", query: "broad classification list" },
      { kind: "web_fetch", query: "https://secondary.example/list" },
    ],
  },
});
assert.match(recovery, /唯一一次自动恢复/);
assert.match(recovery, /site:<域名>/);
assert.match(recovery, /官方事实/);
assert.match(recovery, /已执行 2 次外部检索或读取/);
assert.match(recovery, /已证实子集/);

const rankingRecovery = buildEvidenceRecoveryHint({
  reason: "external_claim_not_in_evidence",
  verificationPlan: { claimKinds: ["ranking"] },
});
assert.match(rankingRecovery, /one named publisher or benchmark/i);
assert.doesNotMatch(rankingRecovery, /classification premise/i);

assert.doesNotThrow(() => buildEvidenceRecoveryHint({
  reason: "unknown_gap",
  verificationPlan: "malformed",
  evidenceSummary: { events: "malformed" },
}));

const inheritedContext = buildEvidenceRecoveryContext({
  sourceTurnId: "turn_source",
  tools: [
    {
      name: "websearch",
      status: "done",
      input: { query: "example classification" },
      result: "Example Authority record: https://authority.example.gov/record",
    },
    {
      name: "webfetch",
      status: "failed",
      input: { url: "https://failed.example" },
      result: "failed",
    },
    { name: "Bash", status: "done", input: { command: "rg classification src" }, result: "local output" },
  ],
});
assert.equal(inheritedContext?.tools?.length, 1, "only successful replay-safe external evidence is inherited");
assert.equal(inheritedContext.tools[0].metadata.evidenceRecovery.sourceTurnId, "turn_source");
assert.equal(restoreEvidenceRecoveryContext({ ...inheritedContext, schemaVersion: 99 }).length, 0, "malformed context fails closed");
assert.equal(restoreEvidenceRecoveryContext(inheritedContext).length, 1);
const inheritedState = {};
initializeTurnEvidenceState(inheritedState, { evidenceContext: inheritedContext });
assert.equal(inheritedState.inheritedEvidenceTools.length, 1);
assert.equal(inheritedState.evidenceLedger.summary().hasFreshEvidence, true, "inherited evidence seeds the new turn ledger");

const internalRecoveryPrompt = applyInternalRecoveryLayer("Original visible request", {
  kind: "evidence_verify_retry",
  guidance: "Check the missing primary source.",
});
assert.equal(extractUserOriginalRequest(internalRecoveryPrompt), "Original visible request");
assert.match(extractLayerText(internalRecoveryPrompt, "execution_constraints"), /Check the missing primary source/);
assert.equal(isInternalRecoveryPromptText(internalRecoveryPrompt), true);
assert.doesNotMatch(extractUserOriginalRequest(internalRecoveryPrompt), /missing primary source/);

const userText = "某地区目前有哪些正式认证的医院？";
const contract = buildTaskContract({ text: userText });
// Turn-start detection fires on the freshness word only — the EMPTY baseline
// plan knows nothing about accreditation. The model declares the semantics.
assert.equal(contract.externalFactPolicy.verificationPlan.entityEvidenceRequired, false);
{
  const { normalizeVerificationPlan } = require("../src/main/external-claim-profiles.js");
  const { buildExternalFactPolicy } = require("../src/main/external-fact-policy.js");
  const { withExternalFactPolicy } = require("../src/main/task-evidence-policy.js");
  const externalFact = buildExternalFactPolicy({
    active: true,
    reasonCodes: [...contract.externalFactPolicy.reasonCodes, "model_external_fact"],
    requiresFreshness: true,
    requiresSourceLinks: true,
    verificationPlan: normalizeVerificationPlan({ profileIds: ["model_semantic_claim"], ...classificationPlan }),
  });
  contract.externalFactPolicy = externalFact;
  contract.evidencePolicy = withExternalFactPolicy(contract.evidencePolicy, externalFact);
}
const authorityUrl = "https://health.example.gov.cn/accreditation";
// Model-first: the semantic judge rules support from the quoted evidence
// window ("被评定为三级甲等" entails the accreditation claim); the fabricated
// entity has NO window and is stripped by the literal floor.
const supportJudge = async () => ({
  supportedClaims: ["示例市人民医院"],
  unsupportedClaims: [],
  authoritativeUrls: [authorityUrl],
  conflictingClaims: [],
  informalLabel: false,
  framingNote: "",
  stakes: "low",
});
const partial = await evaluateAnswerEvidenceWithJudge({
  assistant: [
    "正式认证医院（共 2 家）：",
    "示例市人民医院",
    "虚构市人民医院",
    authorityUrl,
  ].join("\n"),
  taskContract: contract,
  turnPolicy: buildTurnPolicy({ text: userText, taskContract: contract }),
  evidenceSummary: { hasFreshEvidence: true, counts: { webSources: 1 } },
  tools: [{ result: `示例市人民医院被评定为三级甲等医院。\n${authorityUrl}` }],
  userText,
  recoveryAttempt: true,
}, { judge: supportJudge });
assert.equal(partial.assessment.ok, true);
assert.equal(partial.assessment.salvagedSupportedSubset, true);
assert.match(partial.assistant, /示例市人民医院/);
assert.doesNotMatch(partial.assistant, /虚构市人民医院/);
assert.doesNotMatch(partial.assistant, /共 2 家/);
assert.match(partial.assistant, /仅列出本轮一手证据/);
assert.equal(partial.triggerVerifyRetry, false);

const firstPass = evaluateAnswerEvidence({
  assistant: "正式认证医院：\n虚构市人民医院\nhttps://secondary.example/list",
  taskContract: contract,
  turnPolicy: buildTurnPolicy({ text: userText, taskContract: contract }),
  evidenceSummary: { hasFreshEvidence: true, counts: { webSources: 1 } },
  tools: [{ name: "websearch", result: "https://secondary.example/list" }],
  userText,
});
assert.equal(firstPass.assessment.reason, "entity_claim_not_in_evidence");
assert.equal(firstPass.triggerVerifyRetry, true);
// Model-first fail-open: with a silent verify retry still pending, the original
// answer is delivered verbatim — no banner, no stripping, no honesty note yet.
// Content judgment belongs to the judge/salvage path (see above), never to the
// gate rewriting the user's answer.
assert.equal(firstPass.assistant, "正式认证医院：\n虚构市人民医院\nhttps://secondary.example/list");
assert.doesNotMatch(firstPass.assistant, /⚠️|已从上方名单移除|备注：以上回答/);

const contractPrefix = withTaskContractPrefix(userText, contract);
assert.match(contractPrefix, /Verify the premise before building the roster/);
assert.match(contractPrefix, /Deliver every supported conclusion or an honestly labeled supported subset/);

const production = fs.readFileSync("src/main/external-evidence-recovery.js", "utf8");
assert.doesNotMatch(production, /中国建筑集团|中国冶金科工|中冶|副部级建筑/);

// Domain-vocabulary leak guard (model-first refactor 2026-07-20): the gate's
// production sources must not hardcode any domain's defining vocabulary —
// semantics belong to the model. The ONLY exception is external-fact-policy's
// high-stakes fail-closed floor (medical/legal/finance), which is excluded here.
const gateSources = [
  "src/main/external-claim-profiles.js",
  "src/main/external-claim-gate.js",
  "src/main/entity-claim-evidence.js",
  "src/main/evidence-gate.js",
  "src/main/external-source-authority.js",
  "src/main/evidence-entailment-judge.js",
  "src/main/answer-evidence-finalizer.js",
  "src/main/turn-clock-context.js",
].map((file) => fs.readFileSync(file, "utf8")).join("\n");
assert.doesNotMatch(gateSources, /副部级|正部级|正厅级|副厅级|中管企业|中管|三甲|三级甲等|双一流|vice[- ]ministerial|ministerial[- ]level/i);

const recoveryContextProduction = fs.readFileSync("src/main/turn-recovery-context.js", "utf8");
assert.doesNotMatch(recoveryContextProduction, /China Construction|metallurgical|vice-ministerial/i);

console.log("external-evidence-recovery: ok");
