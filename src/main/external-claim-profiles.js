"use strict";

const {
  normalizeAuthorityHosts,
  normalizeEvidenceAnchorGroups,
} = require("./external-claim-contract");
const { initialResearchRequirements } = require("./external-evidence-recovery");

// Model-first refactor (2026-07-20): this module no longer contains ANY domain
// vocabulary. Turn-start detection builds an empty generic verification plan;
// every semantic refinement (claim kinds, scope dimensions, pinned authority
// hosts) arrives via the model's own verification-plan candidate
// (applyModelVerificationPlanCandidate). Semantics belong to the turn judge;
// code here only normalizes and merges literal plan fields.

const SOURCE_AUTHORITY_ORDER = ["standard", "named_publisher", "primary_or_official", "official_primary"];

function uniqueStrings(values = []) {
  const list = Array.isArray(values) ? values : [];
  return [...new Set(list.map((value) => String(value || "").trim()).filter(Boolean))];
}

function semanticIds(values = []) {
  return uniqueStrings(values)
    .map((value) => value.slice(0, 64))
    .filter((value) => /^[a-z][a-z0-9_:-]*$/i.test(value));
}

function emptyVerificationPlan() {
  return {
    schemaVersion: 3,
    profileIds: [],
    claimKinds: [],
    requiredScopeDimensions: [],
    resolvedScopeDimensions: [],
    scopeResolutionMode: "assume_and_disclose",
    scopeDisclosureRequired: false,
    clarificationRequired: false,
    sourceAuthority: "standard",
    authorityUrlPolicy: "none",
    authorityHosts: [],
    entityEvidenceRequired: false,
    claimEvidenceRequired: false,
    classificationEvidenceRequired: false,
    evidenceAnchorGroups: [],
  };
}

function normalizeVerificationPlan(value = null) {
  const source = value && typeof value === "object" ? value : {};
  const requiredScopeDimensions = uniqueStrings(source.requiredScopeDimensions || []);
  const resolvedScopeDimensions = uniqueStrings(source.resolvedScopeDimensions || []);
  const unresolvedScopeDimensions = requiredScopeDimensions.filter((item) =>
    !resolvedScopeDimensions.includes(item));
  const authorityHosts = normalizeAuthorityHosts(source.authorityHosts);
  const evidenceAnchorGroups = normalizeEvidenceAnchorGroups(source.evidenceAnchorGroups);
  const scopeResolutionMode = source.scopeResolutionMode === "clarify"
    ? "clarify"
    : "assume_and_disclose";
  return {
    schemaVersion: 3,
    profileIds: uniqueStrings(source.profileIds || []).slice(0, 8),
    claimKinds: semanticIds(source.claimKinds || []).slice(0, 8),
    requiredScopeDimensions: requiredScopeDimensions.slice(0, 8),
    resolvedScopeDimensions: resolvedScopeDimensions.slice(0, 8),
    scopeResolutionMode,
    scopeDisclosureRequired: unresolvedScopeDimensions.length > 0 && scopeResolutionMode !== "clarify",
    clarificationRequired: unresolvedScopeDimensions.length > 0 && scopeResolutionMode === "clarify",
    sourceAuthority: ["standard", "named_publisher", "primary_or_official", "official_primary"].includes(source.sourceAuthority)
      ? source.sourceAuthority
      : "standard",
    authorityUrlPolicy: source.authorityUrlPolicy === "government" ? "government" : "none",
    authorityHosts,
    entityEvidenceRequired: Boolean(
      source.entityEvidenceRequired ||
      source.claimEvidenceRequired ||
      source.classificationEvidenceRequired ||
      evidenceAnchorGroups.length,
    ),
    claimEvidenceRequired: Boolean(source.claimEvidenceRequired || evidenceAnchorGroups.length),
    classificationEvidenceRequired: Boolean(source.classificationEvidenceRequired),
    evidenceAnchorGroups,
  };
}

/**
 * Turn-start plans are intentionally EMPTY. Whether a question involves
 * rankings, classifications, hierarchies, or any other domain is a semantic
 * judgment — the model declares it through its verification-plan candidate,
 * and the turn judge rules on it at delivery. No regex gets a vote.
 */
function mergeExternalClaimPlans(current = null, previous = null) {
  const next = normalizeVerificationPlan(current);
  const prior = normalizeVerificationPlan(previous);
  if (!next.profileIds.length) return prior;
  if (!prior.profileIds.length) return next;
  return normalizeVerificationPlan({
    profileIds: [...prior.profileIds, ...next.profileIds],
    claimKinds: [...prior.claimKinds, ...next.claimKinds],
    requiredScopeDimensions: [...prior.requiredScopeDimensions, ...next.requiredScopeDimensions],
    resolvedScopeDimensions: [...prior.resolvedScopeDimensions, ...next.resolvedScopeDimensions],
    scopeResolutionMode: next.scopeResolutionMode === "clarify" || prior.scopeResolutionMode === "clarify"
      ? "clarify"
      : "assume_and_disclose",
    sourceAuthority: SOURCE_AUTHORITY_ORDER.indexOf(next.sourceAuthority) >= SOURCE_AUTHORITY_ORDER.indexOf(prior.sourceAuthority)
      ? next.sourceAuthority
      : prior.sourceAuthority,
    authorityUrlPolicy: next.authorityUrlPolicy !== "none" ? next.authorityUrlPolicy : prior.authorityUrlPolicy,
    authorityHosts: [...prior.authorityHosts, ...next.authorityHosts],
    entityEvidenceRequired: next.entityEvidenceRequired || prior.entityEvidenceRequired,
    claimEvidenceRequired: next.claimEvidenceRequired || prior.claimEvidenceRequired,
    classificationEvidenceRequired: next.classificationEvidenceRequired || prior.classificationEvidenceRequired,
    evidenceAnchorGroups: [...prior.evidenceAnchorGroups, ...next.evidenceAnchorGroups],
  });
}

function normalizeModelVerificationPlan(value = null) {
  const source = value && typeof value === "object" ? value : {};
  return normalizeVerificationPlan({
    ...source,
    profileIds: ["model_semantic_claim"],
    scopeResolutionMode: "assume_and_disclose",
    claimKinds: semanticIds(source.claimKinds),
    authorityUrlPolicy: "none",
  });
}

function mergeModelVerificationPlan(baselineValue = null, candidateValue = null) {
  const baseline = normalizeVerificationPlan(baselineValue);
  const candidate = normalizeModelVerificationPlan(candidateValue);
  if (!candidate.claimKinds.length && !candidate.requiredScopeDimensions.length &&
      candidate.sourceAuthority === "standard" && !candidate.entityEvidenceRequired &&
      !candidate.evidenceAnchorGroups.length && !candidate.authorityHosts.length) return baseline;
  const baselineUnresolved = baseline.requiredScopeDimensions.filter((item) =>
    !baseline.resolvedScopeDimensions.includes(item));
  const acceptedCandidateResolved = candidate.resolvedScopeDimensions.filter((item) =>
    !baselineUnresolved.includes(item));
  return mergeExternalClaimPlans({
    ...candidate,
    resolvedScopeDimensions: acceptedCandidateResolved,
  }, baseline);
}

/** Generic, model-declared-plan requirements only — no domain vocabulary. */
function requirementsForPlan(plan = null) {
  const value = normalizeVerificationPlan(plan);
  const requirements = initialResearchRequirements(value);
  if (value.clarificationRequired) {
    requirements.push("Ask only for the unresolved scope dimensions because the verification plan marks them as genuinely blocking.");
  } else if (value.scopeDisclosureRequired) {
    requirements.push("For unresolved scope dimensions, choose a reasonable default, state that scope or basis explicitly, and note materially different interpretations instead of returning a question-only answer.");
  }
  if (value.entityEvidenceRequired) {
    requirements.push("Map every named entity in the answer to evidence from this turn; do not fill list gaps from memory.");
  }
  if (value.sourceAuthority === "official_primary" || value.sourceAuthority === "primary_or_official") {
    requirements.push("Prefer primary records from the responsible organization, regulator, registry, or governing authority over aggregators and secondary summaries.");
  }
  if (value.claimEvidenceRequired && value.evidenceAnchorGroups.length) {
    requirements.push("Present named conclusions as separate list items and map each item to one evidence passage containing its subject plus at least one alternative from every declared evidence-anchor group.");
  }
  if (value.authorityHosts.length) {
    requirements.push(`Use primary-source links from the declared authority hosts: ${value.authorityHosts.join(", ")}.`);
  }
  if (value.classificationEvidenceRequired) {
    requirements.push("For every positive classification, require evidence for the classification itself, not merely the entity's presence in a directory.");
  }
  return requirements;
}

module.exports = {
  emptyVerificationPlan,
  mergeExternalClaimPlans,
  mergeModelVerificationPlan,
  normalizeModelVerificationPlan,
  normalizeVerificationPlan,
  requirementsForPlan,
};
