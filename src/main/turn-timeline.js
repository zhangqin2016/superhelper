"use strict";

const { buildToolPreviewLabel } = require("./tool-preview-label.cjs");

const GENERIC_STATUS = new Set(["requesting", ""]);
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

function isInternalActivityLabel(text) {
  const value = String(text || "").trim();
  if (!value) return true;
  const lower = value.toLowerCase();
  if (INTERNAL_ACTIVITY_LABELS.has(value) || INTERNAL_ACTIVITY_LABELS.has(lower)) return true;
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(lower)) return true;
  return false;
}

function isMeaningfulActivityLabel(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (GENERIC_STATUS.has(value.toLowerCase())) return false;
  if (isInternalActivityLabel(value)) return false;
  return true;
}

function toolPreview(tool = {}) {
  if ((!tool.input || !Object.keys(tool.input).length) && tool.partialJson) {
    try {
      const parsed = JSON.parse(tool.partialJson);
      if (parsed && typeof parsed === "object") {
        return buildToolPreviewLabel({ ...tool, input: parsed });
      }
    } catch {
      // streaming partial JSON
    }
  }
  return buildToolPreviewLabel(tool);
}

const TASK_NOTICE_CODES = new Set(["taskProgress", "taskStarted", "taskCompleted", "thinkingProgress"]);

function activityFromProcessPayload(payload = {}) {
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

function activityFromEngineNotice(notice = {}) {
  const code = String(notice.code || "");
  const detail = String(notice.detail || "").trim();
  if (code === "thinkingProgress") return null;
  if (code === "taskProgress" || code === "taskStarted" || code === "taskCompleted") return null;
  if (code === "apiRetry" && detail) return detail;
  if (notice.level === "progress") return null;
  return null;
}

function setActivityLabel(target, label) {
  if (!isMeaningfulActivityLabel(label)) return;
  const next = String(label).trim();
  if (target.activityLabel === next) return;
  target.activityLabel = next;
}

function ensureTimeline(target) {
  if (!Array.isArray(target.timeline)) target.timeline = [];
  return target.timeline;
}

function upsertTimelineThinking(target, text, ts = Date.now()) {
  const piece = String(text || "");
  if (!piece) return;
  const timeline = ensureTimeline(target);
  const existing = timeline.find((entry) => entry.kind === "thinking");
  if (existing) {
    existing.text = `${existing.text || ""}${piece}`;
    existing.ts = ts;
    return;
  }
  timeline.push({ kind: "thinking", ts, text: piece, collapsed: true });
}

function upsertTimelineTool(target, tool, ts = Date.now()) {
  if (!tool?.id) return;
  const timeline = ensureTimeline(target);
  let entry = timeline.find((item) => item.kind === "tool" && item.id === tool.id);
  if (!entry) {
    entry = {
      kind: "tool",
      id: tool.id,
      ts,
      name: tool.name || "Tool",
      preview: toolPreview(tool),
      input: tool.input || {},
      partialJson: tool.partialJson || "",
      status: tool.status || "running",
      result: tool.result || null,
    };
    if (entry.input && Object.keys(entry.input).length > 0) {
      entry.preview = toolPreview({ ...entry, partialJson: "" });
    }
    timeline.push(entry);
    if (entry.status === "running" && entry.input && Object.keys(entry.input).length > 0) {
      setActivityLabel(target, entry.preview);
    }
    return;
  }
  entry.ts = ts;
  if (tool.name) entry.name = tool.name;
  if (tool.input) entry.input = tool.input;
  if (tool.partialJson) entry.partialJson = tool.partialJson;
  if (tool.status) entry.status = tool.status;
  if (tool.result !== undefined) entry.result = tool.result;
  entry.preview = entry.input && Object.keys(entry.input).length > 0
    ? toolPreview({ ...entry, partialJson: "" })
    : toolPreview(entry);
  if (entry.status === "running" && tool.input && Object.keys(tool.input).length > 0) {
    setActivityLabel(target, entry.preview);
  }
}

function appendTimelineNotice(target, notice, ts = Date.now()) {
  if (!notice || notice.panel === false) return;
  ensureTimeline(target).push({
    kind: "notice",
    ts,
    code: notice.code || "",
    level: notice.level || "info",
    detail: notice.detail || notice.message || "",
  });
}

function runningToolActivity(tools) {
  if (!tools) return null;
  const values = tools instanceof Map ? tools.values() : tools;
  for (const tool of values) {
    if (tool?.status === "running") return toolPreview(tool);
  }
  return null;
}

function resolveActivityLabel(liveTurn = {}) {
  const running = runningToolActivity(liveTurn.tools);
  if (running) return running;
  if (isMeaningfulActivityLabel(liveTurn.activityLabel)) return liveTurn.activityLabel;
  return null;
}

function buildTimelineFromLegacy(state = {}) {
  const timeline = [];
  const ts = state.startedAt || Date.now();
  if (state.thinkingText?.trim()) {
    timeline.push({
      kind: "thinking",
      ts,
      text: state.thinkingText.trim(),
      collapsed: true,
    });
  }
  for (const tool of state.tools?.values?.() || state.tools || []) {
    if (!tool?.id) continue;
    timeline.push({
      kind: "tool",
      id: tool.id,
      ts,
      name: tool.name || "Tool",
      preview: toolPreview(tool),
      input: tool.input || {},
      partialJson: tool.partialJson || "",
      status: tool.status || "done",
      result: tool.result || null,
    });
  }
  for (const event of state.notices || []) {
    const notice = event?.payload?.notice || event?.notice || event;
    if (!notice || notice.panel === false) continue;
    timeline.push({
      kind: "notice",
      ts: event.ts || ts,
      code: notice.code || "",
      level: notice.level || "info",
      detail: notice.detail || notice.message || "",
    });
  }
  return timeline;
}

function resetTimelineState(target) {
  target.timeline = [];
  target.activityLabel = null;
  target.durationMs = null;
  target.totalCostUsd = null;
}

module.exports = {
  activityFromEngineNotice,
  activityFromProcessPayload,
  appendTimelineNotice,
  buildTimelineFromLegacy,
  ensureTimeline,
  isMeaningfulActivityLabel,
  resetTimelineState,
  resolveActivityLabel,
  setActivityLabel,
  toolPreview,
  upsertTimelineThinking,
  upsertTimelineTool,
};
