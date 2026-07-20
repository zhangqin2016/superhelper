"use strict";

const { assessEntityClaimEvidence, extractEntityClaims } = require("./entity-claim-evidence");
const {
  forbiddenInferenceForText,
  isPlanClarificationText,
  normalizeVerificationPlan,
} = require("./external-claim-profiles");
const { satisfiesAuthorityUrlPolicy } = require("./external-source-authority");

function isExternalClaimClarification(text = "", verificationPlan = null, baseClarification = false) {
  const plan = normalizeVerificationPlan(verificationPlan);
  const asksForScope = Boolean(baseClarification) ||
    isPlanClarificationText(text, plan);
  return asksForScope && extractEntityClaims(text, plan).length === 0;
}

function assessPlanBeforeCitations(text = "", verificationPlan = null) {
  const plan = normalizeVerificationPlan(verificationPlan);
  const inferenceId = forbiddenInferenceForText(text, plan);
  if (inferenceId) return { ok: false, reason: `forbidden_inference:${inferenceId}` };
  return { ok: true };
}

function assessPlanAfterCitations({ assistant = "", answerUrls = [], evidenceText = "", verificationPlan = null } = {}) {
  const plan = normalizeVerificationPlan(verificationPlan);
  if (!satisfiesAuthorityUrlPolicy(answerUrls, plan.authorityUrlPolicy, plan.authorityHosts)) {
    return { ok: false, reason: "authoritative_source_required" };
  }
  const entityCoverage = assessEntityClaimEvidence({
    assistant,
    evidenceText,
    verificationPlan: plan,
  });
  if (entityCoverage?.ok === false) {
    const conflicts = entityCoverage.conflictingClaims || [];
    return {
      ok: false,
      reason: conflicts.length ? "entity_claim_conflicts_with_evidence" : "entity_claim_not_in_evidence",
      entityCoverage,
      unsupportedClaims: entityCoverage.unsupportedClaims || [],
      conflictingClaims: conflicts,
    };
  }
  return { ok: true, entityCoverage };
}

module.exports = {
  assessPlanAfterCitations,
  assessPlanBeforeCitations,
  isExternalClaimClarification,
};
