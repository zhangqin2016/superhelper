const GENERIC_STATUS = new Set(["requesting", ""]);
const TOKEN_COUNT_RE = /^\d+(\.\d+)?k?\s*tokens$/i;
const INTERNAL_ACTIVITY_LABELS = new Set([
  "system_notice",
  "engine_notice",
  "assistant_text",
  "assistant_thinking",
  "assistant_tool_use",
  "stream_tool_start",
  "tool_result",
  "turn_result",
  "runtime_error",
  "protocol_warning",
  "unknown_runtime_event",
  "unknown_control_request",
  "runtime event",
  "messageDelta",
  "tool use",
  "tool result",
  "turn result",
  "assistant text",
  "thinking",
]);

const TASK_NOTICE_CODES = new Set(["taskProgress", "taskStarted", "taskCompleted", "thinkingProgress"]);

export function isTokenCountDetail(text) {
  return TOKEN_COUNT_RE.test(String(text || "").trim());
}

export function isInternalActivityLabel(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  const lower = value.toLowerCase();
  if (INTERNAL_ACTIVITY_LABELS.has(value) || INTERNAL_ACTIVITY_LABELS.has(lower)) return true;
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(lower)) return true;
  return false;
}

export function isMeaningfulActivityLabel(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (GENERIC_STATUS.has(value.toLowerCase())) return false;
  if (isTokenCountDetail(value)) return false;
  if (isInternalActivityLabel(value)) return false;
  return true;
}

export function activityFromProcessPayload(payload = {}) {
  const event = payload.event || {};
  if (payload.rawSubtype === "status" || event.status !== undefined) {
    const status = String(event.status ?? "").trim();
    if (isMeaningfulActivityLabel(status)) return status;
  }
  for (const action of payload.actions || []) {
    const notice = action.notice;
    if (!notice) continue;
    if (TASK_NOTICE_CODES.has(String(notice.code || ""))) continue;
    const detail = notice.detail;
    if (typeof detail === "string" && isMeaningfulActivityLabel(detail)) {
      return detail.trim();
    }
  }
  const message = event.message ?? payload.summary;
  if (typeof message === "string" && isMeaningfulActivityLabel(message)) {
    return message.trim();
  }
  return null;
}

export function activityFromEngineNotice(notice = {}) {
  const code = String(notice.code || "");
  const detail = String(notice.detail || "").trim();
  if (code === "thinkingProgress") return null;
  if (code === "taskProgress" || code === "taskStarted" || code === "taskCompleted") return null;
  if (code === "apiRetry" && detail) return detail;
  if (notice.level === "progress") return null;
  return null;
}

export function setActivityLabel(target, label) {
  if (!isMeaningfulActivityLabel(label)) return;
  const next = String(label).trim();
  if (target.activityLabel === next) return;
  target.activityLabel = next;
}
