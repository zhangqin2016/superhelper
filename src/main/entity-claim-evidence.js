"use strict";

const { isEvidenceAnchorLabel } = require("./external-claim-contract");
const { normalizeVerificationPlan } = require("./external-claim-profiles");

const INLINE_NAMED_ORG_RE =
  /(?:中国|国家)[㐀-鿿A-Za-z0-9（）()·-]{1,50}?(?:集团有限公司|股份有限公司|有限责任公司|集团公司|工程集团|建设集团|集团|公司|医院|大学|学院|研究院|研究所|协会|委员会|中心)/gu;
const LINE_ENTITY_RE =
  /^(?:[-*+]\s*|\d{1,3}[.)、:]\s*|\|\s*)?([㐀-鿿A-Za-z0-9（）()·&.' -]{2,70}?(?:集团有限公司|股份有限公司|有限责任公司|集团公司|集团|公司|医院|大学|学院|研究院|研究所|协会|委员会|中心|University|College|Hospital|Institute|Association|Corporation|Corp\.?|Inc\.?))(?=\s*(?:\||[-–—:：]|[（(]|$))/iu;
const LATIN_NAMED_ENTITY_RE = /\b([A-Z][A-Za-z0-9.&'-]{1,30}(?:\s+[A-Z][A-Za-z0-9.&'-]{1,30}){0,4})\b/g;
const LATIN_ENTITY_STOPWORDS = new Set(["According", "Classification", "Evidence", "Grade", "Level", "Official", "Source", "The", "Tier"]);
const STRUCTURED_ITEM_RE = /^(?:[-*+]\s+|\d{1,3}[.)、]\s+|\|\s*)(?:\*\*|__)?([^|:：\n（(]{1,100}?)(?:\*\*|__)?(?=\s*(?:\||[-–—:：（(]|$))/u;

function normalize(value = "", limit = 400) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, limit);
}

/**
 * Entity-claim extraction is deliberately MECHANICAL: line shapes and
 * organization suffixes, no domain vocabulary. Whether the evidence actually
 * SUPPORTS what the answer says about an entity is a semantic question and
 * belongs to the turn judge (evidence-entailment-judge) — never to regexes.
 */
function extractEntityClaims(assistant = "", verificationPlan = null) {
  const plan = normalizeVerificationPlan(verificationPlan);
  const claims = [];
  const claimByName = new Map();
  for (const rawLine of String(assistant || "").split(/\r?\n/)) {
    // Strip URLs first so citation lines ("本轮检索来源：https://…") do not
    // yield pseudo-entities like "https" from the latin extractor.
    const line = rawLine.trim().replace(/https?:\/\/\S+/gi, "").trim();
    if (!line) continue;
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
    // A line that is ONLY an entity label plus a trailing colon is a section
    // header ("某等级医院："), not a claim about that entity — mechanical
    // line shape, no vocabulary.
    if (labels.length && /[:：]\s*$/.test(line)) {
      const body = normalize(line.replace(/^(?:[-*+]\s*|\d{1,3}[.)、:]\s*)/, "").replace(/[:：]\s*$/, ""));
      if (body && labels.every((label) => normalize(label) === body)) continue;
    }
    for (const label of [...new Set(labels)]) {
      const normalizedLabel = normalize(label);
      if (!normalizedLabel || claimByName.has(normalizedLabel)) continue;
      const claim = { label, normalizedLabel };
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

/**
 * Split entity claims into three literal buckets:
 *   unsupportedClaims — entity ABSENT from this turn's evidence. Fabrication
 *     floor: never judged, never banner-kept; salvage must strip them.
 *   conflictingClaims — the turn judge ruled the evidence CONTRADICTS the
 *     claim (passed in via judgedConflictingClaims; never overridable).
 *   pendingClaims — entity present in evidence (real windows exist) whose
 *     support has not been semantically ruled on yet. Empties once the judge
 *     verdict arrives: supported labels come back via acceptedClaimLabels,
 *     rejected ones via judgedUnsupportedClaims (they become unsupported for
 *     salvage purposes, but they DID have windows, so a bounded answer may
 *     keep them under a banner in fail-open tiers).
 */
function assessEntityClaimEvidence({
  assistant = "",
  evidenceText = "",
  verificationPlan = null,
  acceptedClaimLabels = [],
  judgedUnsupportedClaims = [],
  judgedConflictingClaims = [],
} = {}) {
  const plan = normalizeVerificationPlan(verificationPlan);
  if (!plan.entityEvidenceRequired) return null;
  const claims = extractEntityClaims(assistant, plan);
  if (!claims.length) return null;
  const toSet = (values) => new Set((Array.isArray(values) ? values : [])
    .map((label) => normalize(label)).filter(Boolean));
  const accepted = toSet(acceptedClaimLabels);
  const judgedUnsupported = toSet(judgedUnsupportedClaims);
  const judgedConflicting = toSet(judgedConflictingClaims);
  const normalizedEvidence = normalize(evidenceText, 40_000);
  const unsupported = [];
  const pending = [];
  const conflicts = [];
  for (const claim of claims) {
    if (accepted.has(claim.normalizedLabel)) continue;
    if (judgedConflicting.has(claim.normalizedLabel)) {
      conflicts.push(claim);
      continue;
    }
    const present = normalizedEvidence.includes(claim.normalizedLabel);
    if (judgedUnsupported.has(claim.normalizedLabel) || !present) {
      unsupported.push(claim);
      continue;
    }
    pending.push(claim);
  }
  return {
    ok: unsupported.length === 0 && pending.length === 0 && conflicts.length === 0,
    schemaVersion: 2,
    claimCount: claims.length,
    unsupportedClaims: unsupported.map(({ label }) => label).slice(0, 10),
    pendingClaims: pending.map(({ label }) => label).slice(0, 10),
    conflictingClaims: conflicts.map(({ label }) => label).slice(0, 10),
  };
}

module.exports = {
  assessEntityClaimEvidence,
  evidenceWindows,
  extractEntityClaims,
};
