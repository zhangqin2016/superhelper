"use strict";

const {
  evidenceSupportsAnchorGroups,
  normalizeAuthorityHosts,
  normalizeEvidenceAnchorGroups,
} = require("./external-claim-contract");
const { initialResearchRequirements } = require("./external-evidence-recovery");

const RANKING_RE = /(?:排行榜?|排名|榜单|前\s*\d+|第\s*\d+\s*名|\btop\s*\d+\b|\brank(?:ing|ed|s)?\b)/i;
const ORGANIZATION_RELATIONSHIP_RE =
  /(?:隶属于|归属|母公司|子公司|子企业|并入|重组|直接监管|直属|parent company|subsidiary|owned by|reports to|merged into|directly supervised)/i;
const REGULATED_CLASSIFICATION_RE =
  /(?:(?:公司|企业|央企|中央企业|医院|大学|学院|学校|机构|协会|研究院).{0,28}(?:级别|等级|副部级|正部级|厅级|中管|一级|二级|三甲|三级甲等|双一流|资质|认证|牌照|直属|监管)|(?:级别|等级|副部级|正部级|厅级|中管|一级|二级|三甲|三级甲等|双一流|资质|认证|牌照|直属|监管).{0,28}(?:公司|企业|央企|中央企业|医院|大学|学院|学校|机构|协会|研究院)|(?:compan(?:y|ies)|enterprises?|hospitals?|universit(?:y|ies)|schools?|organizations?).{0,32}(?:level|tier|grade|accredit|licen[cs]ed|regulated|classification))/i;
const INFORMAL_HIERARCHY_RE =
  /(?:副部级|正部级|正厅级|副厅级|行政级别|中管企业|一级央企|二级公司|ministerial[- ]level|vice[- ]ministerial|administrative rank|centrally[- ]managed)/i;
const ENTITY_SCOPE_RE =
  /(?:(?:直接监管|直属|一级).{0,12}(?:企业|央企|机构)|(?:包括|含|不包括|不含|只算|也算).{0,16}(?:二级|下属|子公司|子企业|附属机构)|directly supervised|first[- ]tier|include.{0,16}subsidiar|exclude.{0,16}subsidiar)/i;
const CLASSIFICATION_BASIS_RE =
  /(?:干部管理权限|任免权限|领导人员.{0,12}(?:管理|任免)|正式(?:行政)?级别|官方(?:等级|分类|认定|名录)|监管口径|评定标准|formal administrative rank|cadre management authority|official classification|accreditation criteria)/i;
const GOVERNMENT_ADMINISTERED_RE =
  /(?:央企|中央企业|副部级|正部级|正厅级|副厅级|行政级别|中管企业|干部管理权限|任免权限|国资委|三甲|三级甲等|双一流|国家级|省级|直属|直接监管|government[- ]regulated|public authority)/i;
const SCOPE_REFINEMENT_RE = /^(?:只算|只要|包括|不包括|按|按照|口径|scope|include|exclude|use)/i;
const PLAN_CLARIFICATION_RE =
  /(?:对象范围|统计范围|直接监管|直属|一级机构|下属机构|子公司|附属机构|分类口径|认定口径|评定标准|正式级别|行业俗称|任免关系|entity scope|directly supervised|subsidiar|classification basis|formal classification|criteria).{0,120}[?？]|[?？].{0,120}(?:对象|范围|直属|下属|子公司|附属|口径|标准|正式|俗称|scope|subsidiar|classification|criteria)/i;
const CLASSIFICATION_ASSERTION_RE =
  /(?:副部级|正部级|正厅级|副厅级|中管企业|一级(?:建筑)?央企|直接监管企业|三甲|三级甲等|双一流|国家级|省级|一级资质|二级资质|[A-C][+级]?级|level\s*[A-CI1-3]+|tier\s*[1-3]|grade\s*[A-C]|accredited|licensed|centrally[- ]managed|first[- ]tier)/i;
const CLASSIFICATION_REJECTION_RE =
  /(?:(?:不应|不能|不可|并非|不是|不再|未被|未获).{0,32}(?:副部级|正部级|正厅级|副厅级|中管企业|一级央企|直接监管企业|三甲|三级甲等|双一流|国家级|资质|认证|牌照)|(?:should not|cannot|is not|no longer|not).{0,40}(?:ministerial|centrally[- ]managed|first[- ]tier|level|tier|grade|accredited|licensed))/i;
const CLASSIFICATION_SUPPORT_RE =
  /(?:副部级|正部级|正厅级|副厅级|中管企业|中共中央决定|中央管理的|三级甲等|三甲医院|双一流(?:建设)?(?:高校|学科)?|国家级|省级|一级资质|二级资质|认证(?:名单|机构)|牌照|official classification|accredit(?:ed|ation)|licen[cs]ed|centrally[- ]managed|central committee decided|level\s*[A-CI1-3]+|tier\s*[1-3]|grade\s*[A-C])/i;
const SUBORDINATE_CONFLICT_RE =
  /(?:全资子企业|全资子公司|二级(?:企业|公司|子公司)|整体并入|隶属于|下属机构|不再作为.{0,24}(?:直接监管|独立机构)|wholly[- ]owned subsidiary|second[- ]tier subsidiary|merged into|subordinate to|no longer directly supervised)/i;
const NEGATIVE_CLASSIFICATION_RE =
  /(?:(?:非|不是|未获|不属于|撤销|取消|移出|除名|降级|失去|不再).{0,32}(?:三甲|三级甲等|双一流|国家级|省级|资质|认证|牌照|级别|等级)|(?:三甲|三级甲等|双一流|国家级|省级|资质|认证|牌照|级别|等级).{0,32}(?:撤销|取消|移出|除名|降级|失去|不再有效)|(?:not|no longer|revoked|removed|downgraded|unlicensed|unaccredited).{0,40}(?:level|tier|grade|classification|accredit|licen[cs]e)|(?:level|tier|grade|classification|accreditation|licen[cs]e).{0,40}(?:revoked|removed|downgraded|no longer valid))/i;
const ORDERED_DIRECTORY_INFERENCE_RE =
  /(?:(?:名录|名单|目录).{0,24}(?:排名|排序|序号)|(?:排名|排序|序号).{0,24}(?:前\s*\d+|第\s*\d+)|前\s*\d+\s*(?:家|所|个)?).{0,70}(?:级别|等级|资质|认证|直属|副部级|厅级|三甲|双一流)|(?:level|tier|grade|classification|status).{0,70}(?:directory|list)\s*order/i;
const ORDERED_DIRECTORY_REJECTION_RE =
  /(?:(?:不能|不应|不可|无法|不要|并非|不是).{0,28}(?:名录|名单|目录).{0,24}(?:排名|排序|序号)|(?:名录|名单|目录).{0,24}(?:排名|排序|序号).{0,28}(?:不能|不应|不可|无法|不代表|不等于|并非)|do not infer.{0,48}(?:directory|list)\s*order|(?:directory|list)\s*order.{0,48}(?:does not|cannot))/i;

const PROFILE_DEFINITIONS = Object.freeze([
  {
    id: "comparative_ranking",
    matches: (source) => RANKING_RE.test(source),
    claimKinds: ["ranking"],
    sourceAuthority: "named_publisher",
  },
  {
    id: "organization_relationship",
    matches: (source) => ORGANIZATION_RELATIONSHIP_RE.test(source),
    claimKinds: ["affiliation"],
    sourceAuthority: "primary_or_official",
    entityEvidenceRequired: true,
  },
  {
    id: "regulated_organization_classification",
    matches: (source) => REGULATED_CLASSIFICATION_RE.test(source) ||
      (INFORMAL_HIERARCHY_RE.test(source) && SCOPE_REFINEMENT_RE.test(source)) ||
      (CLASSIFICATION_BASIS_RE.test(source) && SCOPE_REFINEMENT_RE.test(source)),
    claimKinds: ["classification"],
    sourceAuthority: "official_primary",
    authorityUrlPolicy: (source) => GOVERNMENT_ADMINISTERED_RE.test(source) ? "government" : "none",
    entityEvidenceRequired: true,
    classificationEvidenceRequired: true,
    forbiddenInferenceIds: ["ordered_directory_implies_classification"],
    conflictRuleIds: ["negative_or_revoked_classification"],
  },
]);

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
    forbiddenInferenceIds: [],
    conflictRuleIds: [],
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
      evidenceAnchorGroups.length ||
      (Array.isArray(source.conflictRuleIds) && source.conflictRuleIds.length),
    ),
    claimEvidenceRequired: Boolean(source.claimEvidenceRequired || evidenceAnchorGroups.length),
    classificationEvidenceRequired: Boolean(source.classificationEvidenceRequired),
    evidenceAnchorGroups,
    forbiddenInferenceIds: uniqueStrings(source.forbiddenInferenceIds || []).slice(0, 8),
    conflictRuleIds: uniqueStrings(source.conflictRuleIds || []).slice(0, 8),
  };
}

function buildExternalClaimPlan(text = "") {
  const source = String(text || "").trim().slice(0, 20_000);
  if (!source) return emptyVerificationPlan();
  const hierarchy = INFORMAL_HIERARCHY_RE.test(source);
  const profiles = PROFILE_DEFINITIONS.filter((profile) => profile.matches(source));
  const profileIds = profiles.map((profile) => profile.id);
  const claimKinds = profiles.flatMap((profile) => profile.claimKinds || []);
  const requiredScopeDimensions = [];
  const resolvedScopeDimensions = [];
  const conflictRuleIds = profiles.flatMap((profile) => profile.conflictRuleIds || []);
  const regulated = profileIds.includes("regulated_organization_classification");
  if (hierarchy && regulated) {
    requiredScopeDimensions.push("entity_population", "classification_basis");
    conflictRuleIds.push("subordinate_vs_independent_tier");
  }
  if (ENTITY_SCOPE_RE.test(source)) resolvedScopeDimensions.push("entity_population");
  if (CLASSIFICATION_BASIS_RE.test(source)) resolvedScopeDimensions.push("classification_basis");

  return normalizeVerificationPlan({
    profileIds,
    claimKinds,
    requiredScopeDimensions,
    resolvedScopeDimensions,
    sourceAuthority: profiles.reduce((strongest, profile) =>
      SOURCE_AUTHORITY_ORDER.indexOf(profile.sourceAuthority || "standard") > SOURCE_AUTHORITY_ORDER.indexOf(strongest)
        ? profile.sourceAuthority
        : strongest, "standard"),
    authorityUrlPolicy: profiles.map((profile) =>
      typeof profile.authorityUrlPolicy === "function" ? profile.authorityUrlPolicy(source) : profile.authorityUrlPolicy,
    ).find((value) => value && value !== "none") || "none",
    entityEvidenceRequired: profiles.some((profile) => profile.entityEvidenceRequired),
    classificationEvidenceRequired: profiles.some((profile) => profile.classificationEvidenceRequired),
    forbiddenInferenceIds: profiles.flatMap((profile) => profile.forbiddenInferenceIds || []),
    conflictRuleIds,
  });
}

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
    forbiddenInferenceIds: [...prior.forbiddenInferenceIds, ...next.forbiddenInferenceIds],
    conflictRuleIds: [...prior.conflictRuleIds, ...next.conflictRuleIds],
  });
}

function normalizeModelVerificationPlan(value = null) {
  const source = value && typeof value === "object" ? value : {};
  const allowedInferenceIds = new Set(["ordered_directory_implies_classification"]);
  const allowedConflictIds = new Set(["negative_or_revoked_classification", "subordinate_vs_independent_tier"]);
  return normalizeVerificationPlan({
    ...source,
    profileIds: ["model_semantic_claim"],
    scopeResolutionMode: "assume_and_disclose",
    claimKinds: semanticIds(source.claimKinds),
    authorityUrlPolicy: "none",
    forbiddenInferenceIds: (Array.isArray(source.forbiddenInferenceIds) ? source.forbiddenInferenceIds : [])
      .filter((item) => allowedInferenceIds.has(item)),
    conflictRuleIds: (Array.isArray(source.conflictRuleIds) ? source.conflictRuleIds : [])
      .filter((item) => allowedConflictIds.has(item)),
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

function reasonCodesForPlan(plan = null) {
  const value = normalizeVerificationPlan(plan);
  const reasons = [];
  if (value.claimKinds.includes("affiliation") || value.claimKinds.includes("classification")) {
    reasons.push("organization_status");
  }
  if (value.claimKinds.includes("classification")) reasons.push("regulated_classification");
  return reasons;
}

function requirementsForPlan(plan = null) {
  const value = normalizeVerificationPlan(plan);
  const requirements = initialResearchRequirements(value);
  if (value.clarificationRequired) {
    requirements.push("Ask only for the unresolved scope dimensions because the verification plan marks them as genuinely blocking.");
  } else if (value.scopeDisclosureRequired) {
    requirements.push("For unresolved scope dimensions, choose a reasonable default, state that scope or basis explicitly, and note materially different interpretations instead of returning a question-only answer.");
  }
  if (value.sourceAuthority === "official_primary") {
    requirements.push("Start with the responsible authority's official domain and use its current primary source for the classification or status rule; if broad search returns secondary material, refine with a domain filter and open the original page.");
  } else if (value.sourceAuthority === "primary_or_official") {
    requirements.push("Prefer primary records from the organization, regulator, registry, or governing authority.");
  }
  if (value.entityEvidenceRequired) {
    requirements.push("Map every named entity in the answer to evidence from this turn; do not fill list gaps from memory.");
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
  if (value.forbiddenInferenceIds.length) {
    requirements.push("Do not infer status, grade, authority, or membership from list order or directory position.");
  }
  if (value.conflictRuleIds.length) {
    requirements.push("Reject a claim when current evidence shows an incompatible affiliation, revocation, downgrade, or exclusion.");
  }
  return requirements;
}

function isPlanClarificationText(text = "", plan = null) {
  return normalizeVerificationPlan(plan).requiredScopeDimensions.length > 0 && PLAN_CLARIFICATION_RE.test(text);
}

function isClassificationAssertion(text = "", plan = null) {
  return normalizeVerificationPlan(plan).classificationEvidenceRequired && CLASSIFICATION_ASSERTION_RE.test(text);
}

function isClassificationRejection(text = "") {
  return CLASSIFICATION_REJECTION_RE.test(text);
}

function hasClassificationSupport(text = "") {
  return CLASSIFICATION_SUPPORT_RE.test(text);
}

function hasClaimEvidenceSupport(text = "", plan = null) {
  const value = normalizeVerificationPlan(plan);
  if (value.claimEvidenceRequired && value.evidenceAnchorGroups.length) {
    return evidenceSupportsAnchorGroups(text, value.evidenceAnchorGroups);
  }
  return hasClassificationSupport(text);
}

function hasClaimConflict(text = "", plan = null) {
  const value = normalizeVerificationPlan(plan);
  return (value.conflictRuleIds.includes("subordinate_vs_independent_tier") && SUBORDINATE_CONFLICT_RE.test(text)) ||
    (value.conflictRuleIds.includes("negative_or_revoked_classification") && NEGATIVE_CLASSIFICATION_RE.test(text));
}

function forbiddenInferenceForText(text = "", plan = null) {
  const value = normalizeVerificationPlan(plan);
  if (
    value.forbiddenInferenceIds.includes("ordered_directory_implies_classification") &&
    ORDERED_DIRECTORY_INFERENCE_RE.test(text) &&
    !ORDERED_DIRECTORY_REJECTION_RE.test(text)
  ) return "ordered_directory_implies_classification";
  return "";
}

module.exports = {
  buildExternalClaimPlan,
  emptyVerificationPlan,
  forbiddenInferenceForText,
  hasClaimConflict,
  hasClaimEvidenceSupport,
  hasClassificationSupport,
  isClassificationAssertion,
  isClassificationRejection,
  isPlanClarificationText,
  mergeExternalClaimPlans,
  mergeModelVerificationPlan,
  normalizeVerificationPlan,
  reasonCodesForPlan,
  requirementsForPlan,
};
