"use strict";

const { evidenceSupportsAnchorGroups, isEvidenceAnchorLabel } = require("./external-claim-contract");
const { satisfiesAuthorityUrlPolicy } = require("./external-source-authority");
const {
  hasClaimConflict,
  hasClaimEvidenceSupport,
  hasClassificationSupport,
  isClassificationAssertion,
  isClassificationRejection,
  normalizeVerificationPlan,
} = require("./external-claim-profiles");

const INLINE_NAMED_ORG_RE =
  /(?:中国|国家)[\u3400-\u9fffA-Za-z0-9（）()·-]{1,50}?(?:集团有限公司|股份有限公司|有限责任公司|集团公司|工程集团|建设集团|集团|公司|医院|大学|学院|研究院|研究所|协会|委员会|中心)/gu;
const LINE_ENTITY_RE =
  /^(?:[-*+]\s*|\d{1,3}[.)、:]\s*|\|\s*)?([\u3400-\u9fffA-Za-z0-9（）()·&.' -]{2,70}?(?:集团有限公司|股份有限公司|有限责任公司|集团公司|集团|公司|医院|大学|学院|研究院|研究所|协会|委员会|中心|University|College|Hospital|Institute|Association|Corporation|Corp\.?|Inc\.?))(?=\s*(?:\||[-–—:：]|[（(]|$))/iu;
const LATIN_NAMED_ENTITY_RE = /\b([A-Z][A-Za-z0-9.&'-]{1,30}(?:\s+[A-Z][A-Za-z0-9.&'-]{1,30}){0,4})\b/g;
const LATIN_ENTITY_STOPWORDS = new Set(["According", "Classification", "Evidence", "Grade", "Level", "Official", "Source", "The", "Tier"]);
const STRUCTURED_ITEM_RE = /^(?:[-*+]\s+|\d{1,3}[.)、]\s+|\|\s*)(?:\*\*|__)?([^|:：\n（(]{1,100}?)(?:\*\*|__)?(?=\s*(?:\||[-–—:：（(]|$))/u;

function normalize(value = "", limit = 400) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, limit);
}

function extractEntityClaims(assistant = "", verificationPlan = null) {
  const plan = normalizeVerificationPlan(verificationPlan);
  const claims = [];
  const claimByName = new Map();
  let activeClassificationContext = "";
  for (const rawLine of String(assistant || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isClassificationAssertion(line, plan) && /[:：]\s*$/.test(line)) {
      activeClassificationContext = line;
      continue;
    }
    const labels = [...line.matchAll(INLINE_NAMED_ORG_RE)].map((match) => match[0]);
    const lineMatch = line.match(LINE_ENTITY_RE);
    if (lineMatch) labels.push(lineMatch[1].trim());
    const structuredMatch = plan.entityEvidenceRequired ? line.match(STRUCTURED_ITEM_RE) : null;
    const structuredLabel = structuredMatch?.[1]?.trim() || "";
    if (structuredLabel) labels.push(structuredLabel);
    if (plan.entityEvidenceRequired) {
      labels.push(...[...line.matchAll(LATIN_NAMED_ENTITY_RE)]
        .map((match) => match[1].trim())
        .filter((label) => !LATIN_ENTITY_STOPWORDS.has(label))
        .filter((label) => !isEvidenceAnchorLabel(label, plan.evidenceAnchorGroups)));
    }
    if (isClassificationAssertion(line, plan) && !labels.length) activeClassificationContext = line;
    if (/^#{1,6}\s+/.test(line) && !isClassificationAssertion(line, plan)) activeClassificationContext = "";
    for (const label of [...new Set(labels)]) {
      const normalizedLabel = normalize(label);
      if (!normalizedLabel) continue;
      const genericClaim = plan.claimEvidenceRequired && (
        label === structuredLabel ||
        evidenceSupportsAnchorGroups(`${activeClassificationContext}\n${line}`, plan.evidenceAnchorGroups)
      );
      const classificationClaim = (genericClaim || isClassificationAssertion(`${activeClassificationContext}\n${line}`, plan)) &&
        !isClassificationRejection(line);
      const existing = claimByName.get(normalizedLabel);
      if (existing) {
        existing.classificationClaim ||= classificationClaim;
        continue;
      }
      const claim = { label, normalizedLabel, classificationClaim };
      claimByName.set(normalizedLabel, claim);
      claims.push(claim);
      if (claims.length >= 50) return claims;
    }
  }
  return claims;
}

function evidenceWindows(evidenceText, label, radius = 240) {
  const source = String(evidenceText || "");
  const windows = [];
  let offset = 0;
  while (windows.length < 8) {
    const index = source.indexOf(label, offset);
    if (index < 0) break;
    windows.push(source.slice(Math.max(0, index - radius), index + label.length + radius));
    offset = index + label.length;
  }
  return windows;
}

function evidenceSentenceWindows(evidenceText, label) {
  const source = String(evidenceText || "");
  const windows = [];
  let offset = 0;
  while (windows.length < 8) {
    const index = source.indexOf(label, offset);
    if (index < 0) break;
    const before = source.slice(Math.max(0, index - 260), index);
    const after = source.slice(index + label.length, index + label.length + 300);
    const leftBoundary = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("。"), before.lastIndexOf("！"), before.lastIndexOf("？"));
    const rightOffsets = [after.indexOf("\n"), after.indexOf("。"), after.indexOf("！"), after.indexOf("？")]
      .filter((value) => value >= 0);
    const rightBoundary = rightOffsets.length ? Math.min(...rightOffsets) + 1 : after.length;
    windows.push(`${before.slice(leftBoundary + 1)}${label}${after.slice(0, rightBoundary)}`);
    offset = index + label.length;
  }
  return windows;
}

function hasRequiredClassificationEvidence(windows, plan) {
  return windows.some((window) => {
    const authorityOk = satisfiesAuthorityUrlPolicy(
      window.match(/https?:\/\/\S+/gi) || [],
      plan.authorityUrlPolicy,
      plan.authorityHosts,
    );
    return authorityOk && (
      plan.claimEvidenceRequired
        ? hasClaimEvidenceSupport(window, plan)
        : hasClassificationSupport(window)
    );
  });
}

function assessEntityClaimEvidence({ assistant = "", evidenceText = "", verificationPlan = null } = {}) {
  const plan = normalizeVerificationPlan(verificationPlan);
  if (!plan.entityEvidenceRequired) return null;
  const claims = extractEntityClaims(assistant, plan);
  if (!claims.length) return null;
  const normalizedEvidence = normalize(evidenceText, 40_000);
  const unsupported = claims.filter((claim) => !normalizedEvidence.includes(claim.normalizedLabel));
  const unsupportedClassification = plan.classificationEvidenceRequired || plan.claimEvidenceRequired
    ? claims.filter((claim) => claim.classificationClaim &&
        !hasRequiredClassificationEvidence(evidenceWindows(evidenceText, claim.label, 700), plan))
    : [];
  const conflicts = claims.filter((claim) => {
    if (!claim.classificationClaim) return false;
    const windows = evidenceSentenceWindows(evidenceText, claim.label);
    return windows.some((window) => hasClaimConflict(window, plan));
  });
  const unsupportedLabels = [...new Set([...unsupported, ...unsupportedClassification].map(({ label }) => label))];
  return {
    ok: unsupportedLabels.length === 0 && conflicts.length === 0,
    schemaVersion: 1,
    claimCount: claims.length,
    unsupportedClaims: unsupportedLabels.slice(0, 10),
    unsupportedClassificationClaims: unsupportedClassification.map(({ label }) => label).slice(0, 10),
    conflictingClaims: conflicts.map(({ label }) => label).slice(0, 10),
  };
}

module.exports = {
  assessEntityClaimEvidence,
  extractEntityClaims,
};
