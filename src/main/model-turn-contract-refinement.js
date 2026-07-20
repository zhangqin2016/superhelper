"use strict";

const {
  activateExternalFactPolicyFromObservation,
  applyModelVerificationPlanCandidate,
} = require("./external-fact-policy");
const { resolveModelIntentContractUpdate } = require("./intent-contract");
const { withExternalFactPolicy } = require("./task-evidence-policy");
const { applyIntentContractToTaskRun } = require("./task-run-state");

function parsedObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function modelVerificationPlanFromToolResult(result) {
  const direct = parsedObject(result);
  const candidates = [
    direct?.verificationPlan,
    direct?.result?.verificationPlan,
    direct?.intentContract?.verificationPlan,
    direct?.result?.intentContract?.verificationPlan,
  ];
  for (const item of Array.isArray(direct?.content) ? direct.content : []) {
    const parsed = parsedObject(item?.text);
    candidates.push(parsed?.verificationPlan, parsed?.intentContract?.verificationPlan);
  }
  return candidates.find((value) => value && typeof value === "object" && !Array.isArray(value)) || null;
}

function canActivateGeneralExternalFact(taskContract = null) {
  return Boolean(
    taskContract &&
    taskContract.taskType === "general" &&
    (!Array.isArray(taskContract.categories) || taskContract.categories.length === 0) &&
    !taskContract.contentIntent?.active &&
    !taskContract.programIntent?.active,
  );
}

function applyExternalFactRefinement(taskContract, externalFact) {
  if (!externalFact?.required) return false;
  taskContract.externalFactPolicy = externalFact;
  taskContract.evidencePolicy = withExternalFactPolicy(taskContract.evidencePolicy, externalFact);
  return true;
}

function applyModelTurnContractRefinement({ taskContract = null, taskRun = null, toolResult = null } = {}) {
  if (!taskContract || typeof taskContract !== "object") return null;
  let intentContractRefined = false;
  let verificationPlanRefined = false;
  const refinedIntent = resolveModelIntentContractUpdate(taskContract.intentContract, toolResult);
  if (refinedIntent) {
    taskContract.intentContract = refinedIntent;
    applyIntentContractToTaskRun(taskRun, refinedIntent);
    intentContractRefined = true;
  }
  const candidate = modelVerificationPlanFromToolResult(toolResult);
  const externalFactWasRequired = Boolean(taskContract.externalFactPolicy?.required);
  const refinedExternalFact = applyModelVerificationPlanCandidate(
    taskContract.externalFactPolicy,
    candidate,
    { allowActivation: canActivateGeneralExternalFact(taskContract) },
  );
  verificationPlanRefined = applyExternalFactRefinement(taskContract, refinedExternalFact);
  if (refinedIntent?.clarificationPolicy?.required && taskContract.evidencePolicy?.externalFact) {
    taskContract.evidencePolicy.allowClarificationWithoutEvidence = true;
  }
  return intentContractRefined || verificationPlanRefined
    ? {
        intentContractRefined,
        verificationPlanRefined,
        externalFactActivated: verificationPlanRefined && !externalFactWasRequired,
      }
    : null;
}

function applyObservedExternalEvidence({ taskContract = null, evidenceEvent = null } = {}) {
  if (!canActivateGeneralExternalFact(taskContract)) return null;
  if (!new Set(["web_search", "web_fetch", "external_observation"]).has(evidenceEvent?.kind)) return null;
  const externalFact = activateExternalFactPolicyFromObservation(taskContract.externalFactPolicy);
  if (!applyExternalFactRefinement(taskContract, externalFact)) return null;
  return { externalFactActivated: true, observedExternalEvidence: true };
}

function applyToolTurnContractRefinement({ taskContract = null, taskRun = null, tool = null, evidenceEvent = null } = {}) {
  if (!taskContract || !tool) return null;
  const isIntentCommit = String(tool.name || "").toLowerCase().endsWith("lily_intent_contract_commit");
  const modelResult = isIntentCommit
    ? applyModelTurnContractRefinement({ taskContract, taskRun, toolResult: tool.result })
    : null;
  const observedResult = applyObservedExternalEvidence({ taskContract, evidenceEvent });
  if (!modelResult && !observedResult) return null;
  return {
    ...(modelResult || {}),
    ...(observedResult || {}),
    externalFactActivated: Boolean(modelResult?.externalFactActivated || observedResult?.externalFactActivated),
  };
}

module.exports = {
  applyObservedExternalEvidence,
  applyToolTurnContractRefinement,
  applyModelTurnContractRefinement,
  canActivateGeneralExternalFact,
  modelVerificationPlanFromToolResult,
};
