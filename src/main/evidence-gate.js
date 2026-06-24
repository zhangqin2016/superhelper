"use strict";

const STRONG_CLAIM_RE =
  /(已(?:修复|完成|部署|发布|验证|解决|确认)|修好了|完成了|部署完成|发布完成|生效了|原因是|根因是|问题在于|fixed|completed|deployed|verified|root cause|the cause is)/i;

const EVIDENCE_MARKER_RE =
  /(证据|依据|来源|已验证|验证结果|测试通过|命令输出|日志|文件|行号|screenshot|source|evidence|verified|test output|command output|log|fixture|\/[\w.-]+\/|\b[\w.-]+\.(?:js|mjs|cjs|ts|tsx|json|md|py|java|css|html):\d+\b)/i;

function assessFinalAnswerEvidence({ assistant = "", evidencePolicy = null, toolCount = 0, fileChangeCount = 0 } = {}) {
  const text = String(assistant || "").trim();
  const required = Boolean(evidencePolicy?.required);
  if (!required || !text) {
    return { ok: true, required, strongClaim: false, hasEvidence: false, reason: "" };
  }
  const strongClaim = STRONG_CLAIM_RE.test(text);
  const hasEvidence = toolCount > 0 || fileChangeCount > 0 || EVIDENCE_MARKER_RE.test(text);
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
