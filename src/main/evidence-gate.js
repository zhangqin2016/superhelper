"use strict";

const STRONG_CLAIM_RE =
  /(已(?:修复|完成|部署|发布|验证|解决|确认)|修好了|完成了|部署完成|发布完成|生效了|原因是|根因是|问题在于|fixed|completed|deployed|verified|root cause|the cause is)/i;

const EVIDENCE_MARKER_RE =
  /(证据|依据|来源|已验证|验证结果|测试通过|命令输出|日志|文件|行号|screenshot|source|evidence|verified|test output|command output|log|fixture|\/[\w.-]+\/|\b[\w.-]+\.(?:js|mjs|cjs|ts|tsx|json|md|py|java|css|html):\d+\b)/i;

const ROOT_CAUSE_RE = /(原因是|根因是|问题在于|root cause|the cause is)/i;
const FIXED_RE = /(已(?:修复|解决)|修好了|fixed|resolved)/i;
const VERIFIED_RE = /(已(?:验证|确认)|验证通过|测试通过|verified|confirmed)/i;
const COVERAGE_RE = /(全部|全量|所有(?:问题|相关|文件|位置|地方|出现|引用|调用)|彻底(?:找出|检查|排查)|不要漏|all occurrences|all related|every occurrence)/i;
const NO_FINDING_RE = /(未发现|没有发现|没发现|不存在|没有.*问题|no (?:issue|problem|bug)s? found|nothing (?:else )?(?:found|left))/i;
const FRESH_RE = /(最新|当前|现在|实时|today|latest|current|now)/i;

function hasCount(summary, key) {
  const value = summary?.counts?.[key];
  return Number.isFinite(value) && value > 0;
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

function assessFinalAnswerEvidence({
  assistant = "",
  evidencePolicy = null,
  toolCount = 0,
  fileChangeCount = 0,
  turnPolicy = null,
  evidenceSummary = null,
} = {}) {
  const text = String(assistant || "").trim();
  const required = Boolean(evidencePolicy?.required);
  if (!required || !text) {
    return { ok: true, required, strongClaim: false, hasEvidence: false, reason: "" };
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
  const notice = [
    "",
    "证据门槛：上面的结论缺少可核验证据支撑，不能视为已确认事实。需要通过文件引用、命令/测试输出、日志、接口返回或线上检查结果验证后才能确认。",
  ].join("\n");
  return `${text}${notice}`;
}

module.exports = {
  assessFinalAnswerEvidence,
  appendEvidenceGateNotice,
};
