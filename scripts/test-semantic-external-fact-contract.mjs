#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { evaluateAnswerEvidence, evaluateAnswerEvidenceWithJudge } = require("../src/main/answer-evidence-finalizer.js");
const { findBrokerTool } = require("../src/main/mcp/tool-broker-registry.js");
const {
  applyModelTurnContractRefinement,
  applyObservedExternalEvidence,
  applyToolTurnContractRefinement,
} = require("../src/main/model-turn-contract-refinement.js");
const { buildTaskContract } = require("../src/main/task-contract.js");
const { buildTurnPolicy } = require("../src/main/turn-policy.js");

const userText = "Which providers satisfy the requested assurance status?";
const authorityUrl = "https://registry.authority.test/assurance";

async function semanticPlanResult(overrides = {}) {
  const intentTool = findBrokerTool({ sessionId: "semantic-fact", activeSkillIds: [] }, "lily_intent_contract_commit");
  assert(intentTool);
  return intentTool.handler({
    objective: "Identify providers whose status is proven by primary evidence",
    verificationPlan: {
      externalFact: true,
      claimKinds: ["zeta_assurance_status"],
      sourceAuthority: "official_primary",
      authorityHosts: ["authority.test"],
      entityEvidenceRequired: true,
      claimEvidenceRequired: true,
      evidenceAnchorGroups: [
        ["Zeta Assurance"],
        ["authorized", "authorization"],
      ],
      ...overrides,
    },
  });
}

function assess(taskContract, assistant, evidence) {
  return evaluateAnswerEvidence({
    assistant,
    taskContract,
    turnPolicy: buildTurnPolicy({ text: userText, taskContract }),
    evidenceSummary: { hasFreshEvidence: true, hasDocumentEvidence: false, counts: { webSources: 1 } },
    tools: [{ name: "websearch", result: evidence }],
    userText,
  }).assessment;
}

const unknownContract = buildTaskContract({ text: userText });
assert.equal(unknownContract.taskType, "general");
assert.equal(unknownContract.externalFactPolicy.required, false);
const refinement = applyModelTurnContractRefinement({
  taskContract: unknownContract,
  toolResult: await semanticPlanResult(),
});
assert.equal(refinement.externalFactActivated, true);
assert.equal(unknownContract.taskType, "general", "the model may add evidence requirements but may not reroute the host task");
assert.equal(unknownContract.externalFactPolicy.required, true);
assert.equal(unknownContract.evidencePolicy.required, true);
assert(unknownContract.evidencePolicy.requiredEvidenceKinds.includes("external"));
assert.deepEqual(unknownContract.externalFactPolicy.verificationPlan.claimKinds, ["zeta_assurance_status"]);
assert.deepEqual(unknownContract.externalFactPolicy.verificationPlan.authorityHosts, ["authority.test"]);

// Entity present in evidence but support unproven → PENDING the semantic
// judge (was: anchor-group vocabulary). The judge then rules from the quoted
// window: a directory mention does not entail authorization.
const irrelevantEvidence = assess(
  unknownContract,
  `Nimbus Cloud is Zeta Assurance authorized.\n${authorityUrl}`,
  `Nimbus Cloud appears in a provider directory. Zeta Assurance is a program.\n${authorityUrl}`,
);
assert.equal(irrelevantEvidence.reason, "semantic_support_unverified");
assert(irrelevantEvidence.entityCoverage.pendingClaims.includes("Nimbus Cloud"));

const judgedIrrelevant = await evaluateAnswerEvidenceWithJudge({
  assistant: `Nimbus Cloud is Zeta Assurance authorized.\n${authorityUrl}`,
  taskContract: unknownContract,
  turnPolicy: buildTurnPolicy({ text: userText, taskContract: unknownContract }),
  evidenceSummary: { hasFreshEvidence: true, hasDocumentEvidence: false, counts: { webSources: 1 } },
  tools: [{ name: "websearch", result: `Nimbus Cloud appears in a provider directory. Zeta Assurance is a program.\n${authorityUrl}` }],
  userText,
}, {
  judge: async () => ({
    supportedClaims: [],
    unsupportedClaims: ["Nimbus Cloud"],
    authoritativeUrls: [],
    conflictingClaims: [],
    informalLabel: false,
    framingNote: "",
    stakes: "low",
  }),
});
assert.equal(judgedIrrelevant.assessment.ok, false);
assert(judgedIrrelevant.assessment.unsupportedClaims.includes("Nimbus Cloud"));

const groundedEvidence = await evaluateAnswerEvidenceWithJudge({
  assistant: `Nimbus Cloud is Zeta Assurance authorized.\n${authorityUrl}`,
  taskContract: unknownContract,
  turnPolicy: buildTurnPolicy({ text: userText, taskContract: unknownContract }),
  evidenceSummary: { hasFreshEvidence: true, hasDocumentEvidence: false, counts: { webSources: 1 } },
  tools: [{ name: "websearch", result: `Nimbus Cloud is Zeta Assurance authorized.\n${authorityUrl}` }],
  userText,
}, {
  judge: async () => ({
    supportedClaims: ["Nimbus Cloud"],
    unsupportedClaims: [],
    authoritativeUrls: [],
    conflictingClaims: [],
    informalLabel: false,
    framingNote: "",
    stakes: "low",
  }),
});
assert.equal(groundedEvidence.assessment.ok, true);

const wrongAuthority = assess(
  unknownContract,
  "Nimbus Cloud is Zeta Assurance authorized.\nhttps://authority.test.attacker.invalid/assurance",
  "Nimbus Cloud is Zeta Assurance authorized.\nhttps://authority.test.attacker.invalid/assurance",
);
assert.equal(wrongAuthority.reason, "authoritative_source_required");

const cjkListContract = buildTaskContract({ text: userText });
applyModelTurnContractRefinement({ taskContract: cjkListContract, toolResult: await semanticPlanResult() });
const cjkList = assess(
  cjkListContract,
  `- 星云一号\n- 星云二号\n${authorityUrl}`,
  `星云一号获得 Zeta Assurance authorization。\n${authorityUrl}`,
);
assert.equal(cjkList.reason, "entity_claim_not_in_evidence");
assert(cjkList.unsupportedClaims.includes("星云二号"), "structural list extraction must not depend on organization suffixes");

const observedContract = buildTaskContract({ text: "Explain the requested provider status." });
const observed = applyObservedExternalEvidence({ taskContract: observedContract, evidenceEvent: { kind: "web_search" } });
assert.equal(observed.externalFactActivated, true);
assert.equal(observedContract.externalFactPolicy.reasonCodes.includes("observed_external_research"), true);
assert.deepEqual(observedContract.evidencePolicy.requiredEvidenceKinds, ["external"]);

const observedThroughTool = buildTaskContract({ text: "Explain the requested provider status." });
const toolRefinement = applyToolTurnContractRefinement({
  taskContract: observedThroughTool,
  tool: { name: "websearch", result: "no result" },
  evidenceEvent: { kind: "web_search", success: false },
});
assert.equal(toolRefinement.externalFactActivated, true, "even a failed research attempt must prevent a memory-only answer");

const fileReadContract = buildTaskContract({ text: "Explain this local file." });
assert.equal(applyObservedExternalEvidence({ taskContract: fileReadContract, evidenceEvent: { kind: "file_read" } }), null);
assert.equal(fileReadContract.externalFactPolicy.required, false);

const localCodeContract = buildTaskContract({ text: "Build a provider status dashboard and write tests." });
const localPlan = await semanticPlanResult();
assert.equal(applyModelTurnContractRefinement({ taskContract: localCodeContract, toolResult: localPlan }).verificationPlanRefined, false);
assert.equal(localCodeContract.externalFactPolicy.required, false, "model semantics cannot reroute an operational task");
assert.equal(applyObservedExternalEvidence({ taskContract: localCodeContract, evidenceEvent: { kind: "web_search" } }), null);

const undeclaredContract = buildTaskContract({ text: userText });
const undeclared = await semanticPlanResult({ externalFact: false });
applyModelTurnContractRefinement({ taskContract: undeclaredContract, toolResult: undeclared });
assert.equal(undeclaredContract.externalFactPolicy.required, false, "activation requires an explicit semantic declaration");

const malformedContract = buildTaskContract({ text: userText });
applyModelTurnContractRefinement({
  taskContract: malformedContract,
  toolResult: { verificationPlan: { externalFact: true, claimKinds: ["not valid whitespace"] } },
});
assert.equal(malformedContract.externalFactPolicy.required, false, "malformed semantic plans fail open to the baseline");

const noResearchContract = buildTaskContract({ text: `${userText} Do not search.` });
assert.equal(noResearchContract.externalFactPolicy.researchProhibited, true);
applyModelTurnContractRefinement({ taskContract: noResearchContract, toolResult: await semanticPlanResult() });
assert.equal(noResearchContract.externalFactPolicy.required, true);
assert.equal(noResearchContract.externalFactPolicy.researchProhibited, true, "semantic activation must preserve user constraints");

const productionSources = [
  "src/main/external-claim-contract.js",
  "src/main/model-turn-contract-refinement.js",
  "src/main/mcp/intent-contract-tool-definition.js",
].map((file) => fs.readFileSync(file, "utf8")).join("\n");
assert.doesNotMatch(productionSources, /FedRAMP|FDA|banking license|pharmaceutical/i);

console.log("semantic-external-fact-contract: ok");
