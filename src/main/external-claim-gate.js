"use strict";

const { assessEntityClaimEvidence, extractEntityClaims } = require("./entity-claim-evidence");
const { normalizeVerificationPlan } = require("./external-claim-profiles");
const { satisfiesAuthorityHosts } = require("./external-claim-contract");

function isExternalClaimClarification(text = "", verificationPlan = null, baseClarification = false) {
  const plan = normalizeVerificationPlan(verificationPlan);
  return Boolean(baseClarification) && extractEntityClaims(text, plan).length === 0;
}

/**
 * After literal citation grounding, the remaining plan checks are STAGES the
 * semantic turn judge (evidence-entailment-judge) must rule on — this module
 * only reports what is pending; it no longer decides semantics itself.
 *   - authority adequacy: a publisher-identity judgment → judge. Only pinned
 *     authorityHosts (user/model-declared) stay an absolute literal floor.
 *   - entity support: presence is literal (assessEntityClaimEvidence);
 *     entailment/conflict rulings arrive via accepted/judged claim labels.
 */
function assessPlanAfterCitations({
  assistant = "",
  answerUrls = [],
  evidenceText = "",
  verificationPlan = null,
  acceptedClaimLabels = [],
  acceptedAuthorityUrls = [],
  judgedUnsupportedClaims = [],
  judgedConflictingClaims = [],
} = {}) {
  const plan = normalizeVerificationPlan(verificationPlan);
  // Pinned authority hosts are an absolute floor — never judge-overridable.
  if (!satisfiesAuthorityHosts(answerUrls, plan.authorityHosts)) {
    return { ok: false, reason: "authoritative_source_required", authorityPinned: true };
  }
  const entityCoverage = assessEntityClaimEvidence({
    assistant,
    evidenceText,
    verificationPlan: plan,
    acceptedClaimLabels,
    judgedUnsupportedClaims,
    judgedConflictingClaims,
  });
  // The plan asks for an authority tier and nothing has been judge-accepted
  // yet: pending the semantic authority verdict (was: a gov-TLD regex). The
  // tier itself is MODEL-declared — sourceAuthority primary_or_official /
  // official_primary in the verification plan, or an explicit URL policy.
  const authorityTierRequired = plan.authorityUrlPolicy !== "none" ||
    ["primary_or_official", "official_primary"].includes(plan.sourceAuthority);
  // A satisfied host pin IS the authority decision (the user/model named the
  // publisher) — no further adequacy verdict is needed for those urls.
  const pinnedSatisfied = plan.authorityHosts.length > 0;
  const authorityPending = Boolean(
    authorityTierRequired && !pinnedSatisfied && answerUrls.length && !acceptedAuthorityUrls.length,
  );
  // Failure precedence: the fabrication floor (judge-ruled conflicts, entities
  // absent from evidence) outranks source tier; an unproven-but-windowed claim
  // is the softest failure. All pending facts ride along so ONE judge call can
  // rule claims and urls together.
  const conflicts = entityCoverage?.conflictingClaims || [];
  const unsupported = entityCoverage?.unsupportedClaims || [];
  const pending = entityCoverage?.pendingClaims || [];
  const reason = conflicts.length
    ? "entity_claim_conflicts_with_evidence"
    : unsupported.length
      ? "entity_claim_not_in_evidence"
      : authorityPending
        ? "authoritative_source_required"
        : pending.length
          ? "semantic_support_unverified"
          : "";
  if (reason) {
    return {
      ok: false,
      reason,
      authorityPending,
      entityCoverage,
      unsupportedClaims: unsupported,
      pendingClaims: pending,
      conflictingClaims: conflicts,
    };
  }
  return { ok: true, entityCoverage };
}

module.exports = {
  assessPlanAfterCitations,
  isExternalClaimClarification,
};
