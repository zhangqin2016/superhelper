"use strict";

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
      return Boolean(summary.hasFreshEvidence || hasCount(summary, "webSources"));
    case "document":
      return Boolean(summary.hasDocumentEvidence || hasCount(summary, "documents"));
    default:
      return true;
  }
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

function assessPolicyBackedClaims(text, { turnPolicy = null, evidenceSummary = null, fileChangeCount = 0 } = {}) {
  if (!turnPolicy && !evidenceSummary) return null;
  const summary = evidenceSummary || {};
  if (ROOT_CAUSE_RE.test(text) && !summary.hasFileReadEvidence && !hasCount(summary, "events")) {
    return { ok: false, reason: "root_cause_without_source_evidence" };
  }
  if (FIXED_RE.test(text) && fileChangeCount <= 0 && !summary.hasFileChangeEvidence && !hasCount(summary, "fileWrites")) {
    return { ok: false, reason: "fixed_claim_without_change_evidence" };
  }
  if (VERIFIED_RE.test(text) && !summary.hasVerificationEvidence && !hasCount(summary, "verifications")) {
    return { ok: false, reason: "verified_claim_without_verification" };
  }
  if (
    turnPolicy?.taskType === "media_generation" &&
    MEDIA_OUTPUT_RE.test(text) &&
    fileChangeCount <= 0 &&
    !summary.hasFileChangeEvidence &&
    !hasCount(summary, "fileWrites")
  ) {
    return { ok: false, reason: "media_output_without_file_evidence" };
  }
  if (turnPolicy?.requiresSourceCoverage && SOURCE_CLAIM_RE.test(text)) {
    if (!summary.hasSearchEvidence && !hasCount(summary, "fileSearches") && (summary.coverage?.candidateCount || 0) <= 0) {
      return { ok: false, reason: "source_claim_without_search_evidence" };
    }
    if (!summary.hasFileReadEvidence && !hasCount(summary, "filesRead")) {
      return { ok: false, reason: "source_claim_without_file_read_evidence" };
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
      return { ok: false, reason: "coverage_claim_without_candidate_set" };
    }
    if (candidateCount > 0 && (summary?.coverage?.fullInspection === false || inspectedCount < candidateCount)) {
      return { ok: false, reason: "coverage_claim_without_full_inspection" };
    }
  }
  if (turnPolicy?.requiresFreshness && FRESH_RE.test(text) && !summary.hasFreshEvidence) {
    return { ok: false, reason: "fresh_claim_without_fresh_evidence" };
  }
  return null;
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
const SIGNIFICANT_NUMBER_RE = /\d{1,3}(?:,\d{3})+|\d{4,}|\d+(?:\.\d+)?%/g;

function ungroundedSignificantNumbers(answer, evidenceText, userText) {
  if (process.env.LILY_NUMERIC_GROUNDING === "0") return [];
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
} = {}) {
  const text = String(assistant || "").trim();
  const required = Boolean(evidencePolicy?.required);
  if (!required || !text) {
    return { ok: true, required, strongClaim: false, hasEvidence: false, reason: "" };
  }
  const missingKind = missingRequiredEvidenceKind(evidencePolicy, evidenceSummary || {});
  const taskType = turnPolicy?.taskType || "";
  const strictTaskEvidence = new Set(["architecture_audit", "document_work"]).has(taskType);
  if (missingKind && (strictTaskEvidence || STRONG_CLAIM_RE.test(text)) && !EVIDENCE_GAP_DISCLOSURE_RE.test(text)) {
    return {
      ok: false,
      required,
      strongClaim: true,
      hasEvidence: false,
      reason: `missing_required_evidence:${missingKind}`,
    };
  }
  const policyBacked = assessPolicyBackedClaims(text, { turnPolicy, evidenceSummary, fileChangeCount });
  if (policyBacked?.ok === false) {
    return {
      ok: false,
      required,
      strongClaim: true,
      hasEvidence: false,
      reason: policyBacked.reason,
    };
  }
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
  if (strongClaim || required) {
    const ungroundedNumbers = ungroundedSignificantNumbers(text, evidenceText, userText);
    if (ungroundedNumbers.length) {
      return {
        ok: false,
        required,
        strongClaim: true,
        hasEvidence,
        reason: "numeric_claim_not_in_evidence",
        ungroundedNumbers,
      };
    }
  }
  if (!strongClaim || hasEvidence) {
    return { ok: true, required, strongClaim, hasEvidence, reason: "" };
  }
  return {
    ok: false,
    required,
    strongClaim,
    hasEvidence,
    reason: "strong_claim_without_evidence",
  };
}

function appendEvidenceGateNotice(assistant, assessment) {
  const text = String(assistant || "").trim();
  if (assessment?.ok !== false) return text;
  // Targeted notice when specific numbers are ungrounded — name them, so the user
  // sees exactly which values to distrust instead of a blanket disclaimer.
  if (assessment.reason === "numeric_claim_not_in_evidence" && assessment.ungroundedNumbers?.length) {
    return `${text}\n\n证据门槛：以下数字未出现在本轮工具输出中，可能是估计或臆造，未经核实，请勿当作已确认事实：${assessment.ungroundedNumbers.join("、")}。`;
  }
  const notice = [
    "",
    "证据门槛：上面的结论缺少可核验证据支撑，不能视为已确认事实。需要通过文件引用、命令/测试输出、日志、接口返回或线上检查结果验证后才能确认。",
  ].join("\n");
  return `${text}${notice}`;
}

module.exports = {
  assessFinalAnswerEvidence,
  appendEvidenceGateNotice,
  hasEvidenceKind,
};
