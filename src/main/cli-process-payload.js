"use strict";

const TOOL_RESULT_UI_MAX_CHARS = 12_000;

function truncateToolResultForUi(text) {
  const value = String(text || "");
  if (value.length <= TOOL_RESULT_UI_MAX_CHARS) return { content: value, truncated: false };
  const head = value.slice(0, 6_000);
  const tail = value.slice(-4_000);
  return {
    content: `${head}\n\n[...output truncated for display: ${value.length - head.length - tail.length} characters hidden...]\n\n${tail}`,
    truncated: true,
    fullText: value,
  };
}

function compactProcessEvent(ev) {
  if (!ev || typeof ev !== "object") return {};
  const out = {
    type: ev.type,
    subtype: ev.subtype,
    session_id: ev.session_id,
  };
  if (ev.message !== undefined) out.message = ev.message;
  if (ev.status !== undefined) out.status = ev.status;
  if (ev.result !== undefined) out.result = ev.result;
  if (ev.error !== undefined) out.error = ev.error;
  if (ev.errors !== undefined) out.errors = ev.errors;
  if (ev.usage !== undefined) out.usage = ev.usage;
  if (ev.estimated_tokens !== undefined) out.estimated_tokens = ev.estimated_tokens;
  if (ev.request !== undefined) out.request = ev.request;
  if (ev.response !== undefined) out.response = ev.response;
  if (ev.event !== undefined) out.event = ev.event;
  if (ev.message?.content !== undefined) out.content = ev.message.content;
  return out;
}

function isInternalSummaryLabel(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(value)) return true;
  return false;
}

function processEventSummary(payload) {
  const first = payload.actions.find((action) => action.kind);
  if (!first) {
    const fallback = payload.rawSubtype || payload.rawType || "";
    return isInternalSummaryLabel(fallback) ? "" : fallback;
  }
  if (first.notice?.detail) return first.notice.detail;
  if (first.kind === "assistant_thinking") return first.text || "";
  if (first.kind === "assistant_text") return first.text || "";
  if (first.kind === "assistant_tool_use" || first.kind === "stream_tool_start") {
    return first.name ? `${first.name}` : "";
  }
  if (first.kind === "tool_result") return first.name ? `${first.name}` : "";
  if (first.kind.startsWith("hook_")) return first.name ? `${first.name}` : "";
  if (first.kind === "turn_result") return first.stopReason || "";
  return "";
}

function processEventFromClaudeEvent(ev, actions = []) {
  const payload = {
    rawType: String(ev?.type || ""),
    rawSubtype: String(ev?.subtype || ev?.event?.type || ev?.request?.subtype || ""),
    actions: actions.map((action) => ({
      kind: action.kind || "",
      id: action.id || action.requestId || "",
      name: action.name || action.toolName || action.hookName || "",
      text: action.text || "",
      input: action.input || action.toolInput || null,
      result: action.content || action.event?.result || null,
      notice: action.notice || null,
      stopReason: action.stopReason || action.event?.stop_reason || "",
    })),
    event: compactProcessEvent(ev),
  };
  payload.summary = processEventSummary(payload);
  return payload;
}

module.exports = {
  TOOL_RESULT_UI_MAX_CHARS,
  truncateToolResultForUi,
  processEventFromClaudeEvent,
};
