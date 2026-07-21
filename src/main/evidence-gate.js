"use strict";

const { assessClaimEvidenceCoverage } = require("./claim-evidence-map");
const {
  assessPlanAfterCitations,
  isExternalClaimClarification,
} = require("./external-claim-gate");
const { extractHttpUrls } = require("./external-source-authority");
const { externalFactRiskTier } = require("./external-fact-policy");

const STRONG_CLAIM_RE =
  /(已(?:修复|完成|部署|发布|验证|解决|确认)|修好了|完成了|部署完成|发布完成|生效了|原因是|根因是|问题在于|会导致|导致|失败|缺陷|fixed|completed|deployed|verified|root cause|the cause is|bug|regression|failed|unsupported)/i;

const EVIDENCE_MARKER_RE =
  /(证据|依据|来源|已验证|验证结果|测试通过|命令输出|日志|文件|行号|screenshot|source|evidence|verified|test output|command output|log|fixture|\/[\w.-]+\/|\b[\w.-]+\.(?:js|mjs|cjs|ts|tsx|json|md|py|java|css|html):\d+\b)/i;

const ROOT_CAUSE_RE = /(原因是|根因是|问题在于|root cause|the cause is)/i;
const FIXED_RE = /(已(?:修复|解决)|修好了|fixed|resolved)/i;
const VERIFIED_RE = /(已(?:验证|确认)|验证通过|测试通过|verified|confirmed)/i;
const MEDIA_OUTPUT_RE = /(已(?:生成|保存|导出|创建)|生成了|保存到|导出到|created|generated|saved|exported)/i;
const SOURCE_CLAIM_RE = /(bug|regression|缺陷|会导致|导致|错误|不正确|错了|broken|incorrect)/i;
const COVERAGE_RE = /(全部|全量|所有(?:问题|相关|文件|位置|地方|出现|引用|调用)|彻底(?:找出|检查|排查)|不要漏|all occurrences|all related|every occurrence)/i;
const NO_FINDING_RE = /(未发现|没有发现|没发现|不存在|没有.*问题|no (?:issue|problem|bug)s? found|nothing (?:else )?(?:found|left))/i;
const FRESH_RE = /(最新|当前|现在|实时|today|latest|current|now)/i;
const EVIDENCE_GAP_DISCLOSURE_RE =
  /(无法(?:读取|解析|确认|验证)|不能(?:读取|解析|确认|验证)|未能(?:读取|解析|确认|验证)|没有(?:读取到|解析出|验证)|证据不足|无法确认|未验证|unverified|unable to (?:read|parse|verify|confirm)|could not (?:read|parse|verify|confirm)|cannot (?:read|parse|verify|confirm))/i;
const PARTIAL_SOURCE_DISCLOSURE_RE = /(部分(?:内容|页面|附件|文件)?.{0,12}(?:读取|识别|解析|可见|成功)|只(?:读取|识别|解析).{0,12}部分|内容.{0,12}(?:不完整|被截断)|partial(?:ly)? (?:read|recognized|parsed|available)|only part|truncated)/i;
const SCOPE_CLARIFICATION_RE =
  /(?:地区|国家|市场|时间|年份|日期|类别|品类|指标|口径|榜单|排名来源|region|country|market|time period|year|date|category|metric|criteria|ranking source).{0,80}[?？]|[?？].{0,80}(?:地区|时间|年份|类别|指标|口径|榜单|region|time period|year|category|metric|criteria)/i;
const EXTERNAL_FACT_ASSERTION_RE =
  /(?:排名|排行).{0,16}(?:第|前|top)|第\s*[一二三四五六七八九十百\d]+\s*名|(?:^|\n)\s*\d+\s*[.、)]|\b(?:ranks?|ranked)\s+(?:first|second|third|\d+)|\btop\s*\d+\b|(?:是|为|serves? as|is the).{0,24}(?:ceo|cfo|cto|president|prime minister|董事长|总裁|总统|总理|首相)|[$￥¥€£]\s*\d|\d+(?:\.\d+)?\s*(?:元|美元|欧元|英镑|%|％)|\bv?\d+\.\d+(?:\.\d+)?\b/im;

function hasCount(summary, key) {
  const value = summary?.counts?.[key];
  return Number.isFinite(value) && value > 0;
}

function hasEvidenceKind(summary = {}, kind = "") {
  switch (kind) {
    case "file_search":
      return Boolean(summary.hasSearchEvidence || hasCount(summary, "fileSearches") || (summary.coverage?.candidateCount || 0) > 0);
    case "file_read":
      return Boolean(summary.hasFileReadEvidence || hasCount(summary, "filesRead"));
    case "verification":
      return Boolean(summary.hasVerificationEvidence || hasCount(summary, "verifications"));
    case "file_write":
      return Boolean(summary.hasFileChangeEvidence || hasCount(summary, "fileWrites"));
    case "fresh":
      if (summary.hasFreshEvidence === false) return false;
      return Boolean(summary.hasFreshEvidence || hasCount(summary, "webSources"));
    case "external":
      if (summary.hasFreshEvidence === true || summary.hasDocumentEvidence === true) return true;
      if (summary.hasFreshEvidence === false || summary.hasDocumentEvidence === false) return false;
      return Boolean(hasCount(summary, "externalSources") || hasCount(summary, "webSources") || hasCount(summary, "documents"));
    case "document":
      return Boolean(summary.hasDocumentEvidence || hasCount(summary, "documents"));
    case "document_output":
      return Boolean(summary.hasDocumentOutputEvidence || hasCount(summary, "documentOutputs"));
    case "source_content":
      if (summary.hasSourceContentEvidence === true) return true;
      if (summary.hasSourceContentEvidence === false) return false;
      return hasCount(summary, "sourceContentSources");
    default:
      return true;
  }
}

function isScopeClarification(text = "", evidencePolicy = null) {
  return isExternalClaimClarification(
    text,
    evidencePolicy?.verificationPlan,
    SCOPE_CLARIFICATION_RE.test(text),
  );
}

function assessExternalFactCitations(text, { evidencePolicy = null, evidenceSummary = null, evidenceText = "", userText = "", acceptedClaimLabels = [], acceptedAuthorityUrls = [], judgedUnsupportedClaims = [], judgedConflictingClaims = [] } = {}) {
  if (!evidencePolicy?.externalFact) return null;
  if (evidencePolicy.allowClarificationWithoutEvidence && isScopeClarification(text, evidencePolicy)) {
    return { ok: true, clarification: true, citationCount: 0, groundedCitationCount: 0 };
  }
  if (
    EVIDENCE_GAP_DISCLOSURE_RE.test(text) &&
    !EXTERNAL_FACT_ASSERTION_RE.test(text) &&
    !evidenceSummary?.hasFreshEvidence
  ) {
    return { ok: true, disclosedGap: true, citationCount: 0, groundedCitationCount: 0 };
  }
  if (!evidencePolicy.requireSourceLinks) return { ok: true, citationCount: 0, groundedCitationCount: 0 };
  if (evidenceSummary?.hasDocumentEvidence && !evidenceSummary?.hasFreshEvidence && EVIDENCE_MARKER_RE.test(text)) {
    return { ok: true, documentCitation: true, citationCount: 0, groundedCitationCount: 0 };
  }

  const answerUrls = extractHttpUrls(text);
  if (!answerUrls.length) {
    return { ok: false, reason: "external_fact_without_source_link", citationCount: 0, groundedCitationCount: 0 };
  }
  const evidenceUrls = new Set(extractHttpUrls(`${evidenceText}\n${userText}`));
  const ungroundedUrls = answerUrls.filter((url) => !evidenceUrls.has(url));
  if (ungroundedUrls.length) {
    return {
      ok: false,
      reason: "source_link_not_in_evidence",
      citationCount: answerUrls.length,
      groundedCitationCount: answerUrls.length - ungroundedUrls.length,
      ungroundedUrls: ungroundedUrls.slice(0, 5),
    };
  }
  const planAssessment = assessPlanAfterCitations({
    assistant: text,
    answerUrls,
    evidenceText,
    verificationPlan: evidencePolicy.verificationPlan,
    acceptedClaimLabels,
    acceptedAuthorityUrls,
    judgedUnsupportedClaims,
    judgedConflictingClaims,
  });
  if (planAssessment.ok === false) {
    return {
      ok: false,
      reason: planAssessment.reason,
      citationCount: answerUrls.length,
      groundedCitationCount: answerUrls.length,
      authorityPending: Boolean(planAssessment.authorityPending),
      authorityPinned: Boolean(planAssessment.authorityPinned),
      entityCoverage: planAssessment.entityCoverage,
      unsupportedClaims: planAssessment.unsupportedClaims || [],
      pendingClaims: planAssessment.pendingClaims || [],
      conflictingClaims: planAssessment.conflictingClaims || [],
    };
  }
  return {
    ok: true,
    citationCount: answerUrls.length,
    groundedCitationCount: answerUrls.length,
    entityCoverage: planAssessment.entityCoverage,
  };
}

function missingRequiredEvidenceKind(evidencePolicy = {}, summary = {}) {
  const requiredKinds = Array.isArray(evidencePolicy?.requiredEvidenceKinds)
    ? evidencePolicy.requiredEvidenceKinds
    : [];
  for (const kind of requiredKinds) {
    if (!hasEvidenceKind(summary, kind)) return kind;
  }
  return "";
}

// Mechanical SEMANTIC checks (keyword-matched "claims verified / fixed / root
// cause / coverage / fresh") are ADVISORY TELEMETRY ONLY (2026-07-20 model-first
// direction): models have infinite legitimate phrasings, so a keyword mismatch
// may never fail or decorate an answer. Reasons are recorded on the assessment
// for the learning loop; only LITERAL checks (numeric/URL grounding, entity
// containment) stay hard. Semantics belong to the turn judge.
function collectPolicyAdvisoryReasons(text, { turnPolicy = null, evidenceSummary = null, fileChangeCount = 0 } = {}) {
  if (!turnPolicy && !evidenceSummary) return [];
  const summary = evidenceSummary || {};
  const reasons = [];
  if (ROOT_CAUSE_RE.test(text) && !summary.hasFileReadEvidence && !hasCount(summary, "events")) {
    reasons.push("root_cause_without_source_evidence");
  }
  if (FIXED_RE.test(text) && fileChangeCount <= 0 && !summary.hasFileChangeEvidence && !hasCount(summary, "fileWrites")) {
    reasons.push("fixed_claim_without_change_evidence");
  }
  if (
    VERIFIED_RE.test(text) &&
    !summary.hasVerificationEvidence &&
    !summary.hasCommandEvidence &&
    !hasCount(summary, "verifications")
  ) {
    reasons.push("verified_claim_without_verification");
  }
  if (
    turnPolicy?.taskType === "media_generation" &&
    MEDIA_OUTPUT_RE.test(text) &&
    fileChangeCount <= 0 &&
    !summary.hasFileChangeEvidence &&
    !hasCount(summary, "fileWrites")
  ) {
    reasons.push("media_output_without_file_evidence");
  }
  if (turnPolicy?.requiresSourceCoverage && SOURCE_CLAIM_RE.test(text)) {
    if (!summary.hasSearchEvidence && !hasCount(summary, "fileSearches") && (summary.coverage?.candidateCount || 0) <= 0) {
      reasons.push("source_claim_without_search_evidence");
    }
    if (!summary.hasFileReadEvidence && !hasCount(summary, "filesRead")) {
      reasons.push("source_claim_without_file_read_evidence");
    }
  }
  const coverageAssertion =
    COVERAGE_RE.test(text) ||
    NO_FINDING_RE.test(text) ||
    (turnPolicy?.rigor === "coverage" && STRONG_CLAIM_RE.test(text));
  if ((turnPolicy?.rigor === "coverage" || COVERAGE_RE.test(text)) && coverageAssertion) {
    const candidateCount = summary?.coverage?.candidateCount || 0;
    const inspectedCount = summary?.coverage?.inspectedCount || 0;
    if (!summary.hasSearchEvidence && candidateCount <= 0) {
      reasons.push("coverage_claim_without_candidate_set");
    } else if (candidateCount > 0 && (summary?.coverage?.fullInspection === false || inspectedCount < candidateCount)) {
      reasons.push("coverage_claim_without_full_inspection");
    }
  }
  if (
    turnPolicy?.requiresFreshness &&
    FRESH_RE.test(text) &&
    !summary.hasFreshEvidence &&
    !EVIDENCE_GAP_DISCLOSURE_RE.test(text)
  ) {
    reasons.push("fresh_claim_without_fresh_evidence");
  }
  return reasons;
}

// Deterministic numeric grounding (zero model calls). Data-like numbers — counts
// with thousands separators (27,448), bare 4+ digit counts (19407), and
// percentages (39%) — in a factual answer must come from a real tool run. If such
// a number appears NOWHERE in the turn's tool output OR the user's own prompt, it
// was almost certainly fabricated (a model can't derive "27,448 records" by
// reasoning — only by counting). We flag exactly those numbers. 3-digit and
// smaller bare numbers are deliberately NOT checked (round/derived values → false
// positives). A strong model whose numbers come from tool output is never flagged
// (not made dumber); a weak model's invented counts are caught deterministically.
const SIGNIFICANT_NUMBER_RE = /\d{1,3}(?:,\d{3})+|\d{4,}|\d+(?:\.\d+)?%|\bv?\d+\.\d+(?:\.\d+)?\b|\d+(?:\.\d+)?\s*(?:ms\b|毫秒)/gi;

function ungroundedSignificantNumbers(answer, evidenceText, userText, forceEnabled = false) {
  // Default-on only for external facts; other tasks remain opt-in through
  // LILY_NUMERIC_GROUNDING=1. Computed/file/image numbers often do not appear in
  // rendered tool output, so broad default enforcement would create false alarms.
  if (!forceEnabled && process.env.LILY_NUMERIC_GROUNDING !== "1") return [];
  const matches = String(answer || "").match(SIGNIFICANT_NUMBER_RE);
  if (!matches) return [];
  // Comma-stripped haystack so "27,448" (answer) matches "27448" (tool output).
  const haystack = `${String(evidenceText || "")}\n${String(userText || "")}`.replace(/,/g, "");
  const seen = new Set();
  const ungrounded = [];
  for (const raw of matches) {
    const norm = raw.replace(/[,\s%]/g, "");
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    if (haystack.includes(norm)) continue; // the digits appear in evidence / prompt → grounded
    ungrounded.push(raw.trim());
    if (ungrounded.length >= 8) break;
  }
  return ungrounded;
}

function assessFinalAnswerEvidence({
  assistant = "",
  evidencePolicy = null,
  toolCount = 0,
  fileChangeCount = 0,
  turnPolicy = null,
  evidenceSummary = null,
  evidenceText = "",
  userText = "",
  skipNumericGrounding = false,
  acceptedClaimLabels = [],
  acceptedAuthorityUrls = [],
  judgedUnsupportedClaims = [],
  judgedConflictingClaims = [],
} = {}) {
  const text = String(assistant || "").trim();
  const required = Boolean(evidencePolicy?.required);
  if (!required || !text) {
    return { ok: true, required, strongClaim: false, hasEvidence: false, reason: "" };
  }
  // Advisory-tier external facts (everyday domain vocabulary without any
  // claim-bearing signal) are assessed like ordinary tasks: strong definitive
  // claims still draw a notice, but citations are not mandatory and the answer
  // is never eligible for replacement. See externalFactRiskTier.
  if (evidencePolicy?.externalFact && externalFactRiskTier(evidencePolicy) === "advisory") {
    evidencePolicy = { ...evidencePolicy, externalFact: false, requireSourceLinks: false };
  }
  if (evidencePolicy?.externalFact && evidencePolicy.allowClarificationWithoutEvidence && isScopeClarification(text, evidencePolicy)) {
    return {
      ok: true,
      required,
      strongClaim: false,
      hasEvidence: false,
      reason: "",
      clarification: true,
      citationCount: 0,
      groundedCitationCount: 0,
    };
  }
  if (evidencePolicy?.externalFact && evidencePolicy.scopeClarificationRequired) {
    return {
      ok: false,
      required,
      strongClaim: true,
      hasEvidence: false,
      reason: "scope_clarification_required",
    };
  }
  const missingKind = missingRequiredEvidenceKind(evidencePolicy, evidenceSummary || {});
  const taskType = turnPolicy?.taskType || "";
  const strictTaskEvidence = evidencePolicy?.externalFact || new Set(["architecture_audit", "document_work", "content_extraction"]).has(taskType);
  const acceptableGapDisclosure =
    EVIDENCE_GAP_DISCLOSURE_RE.test(text) &&
    (!evidencePolicy?.externalFact || !EXTERNAL_FACT_ASSERTION_RE.test(text));
  if (missingKind && (strictTaskEvidence || STRONG_CLAIM_RE.test(text)) && !acceptableGapDisclosure) {
    return {
      ok: false,
      required,
      strongClaim: true,
      hasEvidence: false,
      reason: `missing_required_evidence:${missingKind}`,
    };
  }
  if (
    taskType === "content_extraction" &&
    evidenceSummary?.sourceContentCoverage?.status === "partial" &&
    !PARTIAL_SOURCE_DISCLOSURE_RE.test(text)
  ) {
    return {
      ok: false,
      required,
      strongClaim: true,
      hasEvidence: true,
      reason: "partial_source_content_without_disclosure",
    };
  }
  const citationAssessment = assessExternalFactCitations(text, {
    evidencePolicy,
    evidenceSummary,
    evidenceText,
    userText,
    acceptedClaimLabels,
    acceptedAuthorityUrls,
    judgedUnsupportedClaims,
    judgedConflictingClaims,
  });
  if (citationAssessment?.ok === false) {
    return {
      ok: false,
      required,
      strongClaim: true,
      hasEvidence: Boolean(evidenceSummary?.hasFreshEvidence),
      reason: citationAssessment.reason,
      citationCount: citationAssessment.citationCount,
      groundedCitationCount: citationAssessment.groundedCitationCount,
      ungroundedUrls: citationAssessment.ungroundedUrls || [],
      authorityPending: Boolean(citationAssessment.authorityPending),
      authorityPinned: Boolean(citationAssessment.authorityPinned),
      entityCoverage: citationAssessment.entityCoverage || null,
      unsupportedClaims: citationAssessment.unsupportedClaims || [],
      pendingClaims: citationAssessment.pendingClaims || [],
      conflictingClaims: citationAssessment.conflictingClaims || [],
    };
  }
  const claimCoverage = assessClaimEvidenceCoverage({
    assistant: text,
    evidenceText,
    userText,
    externalFact: evidencePolicy?.externalFact,
  });
  if (claimCoverage?.ok === false) {
    return {
      ok: false,
      required,
      strongClaim: true,
      hasEvidence: Boolean(evidenceSummary?.hasFreshEvidence),
      reason: "external_claim_not_in_evidence",
      claimCoverage,
      unsupportedClaims: claimCoverage.unsupportedClaims,
    };
  }
  const advisoryReasons = collectPolicyAdvisoryReasons(text, { turnPolicy, evidenceSummary, fileChangeCount });
  const advisory = advisoryReasons.length ? { advisoryReasons } : {};
  const strongClaim = STRONG_CLAIM_RE.test(text);
  const hasLedgerEvidence = Boolean(
    evidenceSummary?.hasFileReadEvidence ||
      evidenceSummary?.hasSearchEvidence ||
      evidenceSummary?.hasVerificationEvidence ||
      evidenceSummary?.hasFileChangeEvidence ||
      evidenceSummary?.hasFreshEvidence ||
      hasCount(evidenceSummary, "events"),
  );
  const hasEvidence = toolCount > 0 || fileChangeCount > 0 || hasLedgerEvidence || EVIDENCE_MARKER_RE.test(text);
  // Deterministic numeric grounding runs EVEN when hasEvidence is true — the 张钦
  // failure was exactly "tools ran, but the specific numbers were fabricated", so
  // the coarse hasEvidence check passed while the numbers were unsupported.
  // Skip for image/vision turns: numbers there are READ from the image (vision is
  // the evidence) and can't be checked against countable tool output — treating
  // them as ungrounded is a false positive.
  if ((strongClaim || required) && !skipNumericGrounding) {
    const ungroundedNumbers = ungroundedSignificantNumbers(
      text,
      evidenceText,
      userText,
      Boolean(evidencePolicy?.externalFact),
    );
    if (ungroundedNumbers.length) {
      return {
        ok: false,
        required,
        strongClaim: true,
        hasEvidence,
        reason: "numeric_claim_not_in_evidence",
        ungroundedNumbers,
        ...advisory,
      };
    }
  }
  if (!strongClaim || hasEvidence) {
    return {
      ok: true,
      required,
      strongClaim,
      hasEvidence,
      reason: "",
      ...(citationAssessment || {}),
      ...advisory,
    };
  }
  return {
    ok: false,
    required,
    strongClaim,
    hasEvidence,
    reason: "strong_claim_without_evidence",
    ...advisory,
  };
}

module.exports = {
  assessFinalAnswerEvidence,
  extractHttpUrls,
  hasEvidenceKind,
};
