import { buildToolPreviewLabel } from "./tool-preview-label.js";
import { t } from "../i18n/index.js";

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

export function toolPreview(tool = {}) {
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

export function resolveNoticeDetail(entry = {}) {
  const detail = String(entry.detail || "").trim();
  if (detail) return detail;
  const code = String(entry.code || "").trim();
  if (!code) return "";
  const key = `engine.${code}`;
  const translated = t(key);
  return translated === key ? "" : translated;
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

function ensureTimeline(target) {
  if (!Array.isArray(target.timeline)) target.timeline = [];
  return target.timeline;
}

function lastThinkingEntry(timeline) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "thinking") return timeline[index];
  }
  return null;
}

// Thinking blocks interleave with tool blocks (think → act → think again).
// Deltas append to the latest still-streaming thinking block; tool entries and
// explicit closes seal it so the next delta starts a new block. Notices do not
// split a block — they are out-of-band, not content blocks.
export function upsertTimelineThinking(target, text, ts = Date.now()) {
  const piece = String(text || "");
  if (!piece) return;
  closeStreamingBlocks(target, ts, ["text"]);
  const timeline = ensureTimeline(target);
  const existing = lastThinkingEntry(timeline);
  if (existing && existing.status === "streaming") {
    existing.text = `${existing.text || ""}${piece}`;
    existing.ts = ts;
    return;
  }
  const count = timeline.filter((entry) => entry.kind === "thinking").length;
  timeline.push({
    kind: "thinking",
    id: `think_${count + 1}`,
    ts,
    startTs: ts,
    text: piece,
    collapsed: true,
    status: "streaming",
  });
}

// Seals are monotone: blocks only stream at the tail, so walking backward we
// can stop at the first already-sealed thinking/text entry. This keeps the
// per-delta cost O(1) instead of O(timeline) (caught by bench-replay).
export function closeStreamingBlocks(target, ts = Date.now(), kinds = ["thinking", "text"]) {
  if (!Array.isArray(target?.timeline)) return;
  for (let index = target.timeline.length - 1; index >= 0; index -= 1) {
    const entry = target.timeline[index];
    if (entry?.kind !== "thinking" && entry?.kind !== "text") continue;
    if (entry.status !== "streaming") return;
    if (kinds.includes(entry.kind)) {
      entry.status = "done";
      entry.ts = ts;
    }
  }
}

export function closeOpenThinkingBlocks(target, ts = Date.now()) {
  closeStreamingBlocks(target, ts, ["thinking"]);
}

// Assistant prose is a content block like any other: a text delta seals the
// open thinking block, and a later thinking/tool block seals the text block,
// so the timeline keeps the think → act → answer order.
export function appendTimelineText(target, text, ts = Date.now()) {
  const piece = String(text || "");
  if (!piece) return;
  closeStreamingBlocks(target, ts, ["thinking"]);
  const timeline = ensureTimeline(target);
  const last = timeline[timeline.length - 1];
  if (last?.kind === "text" && last.status === "streaming") {
    last.text = `${last.text || ""}${piece}`;
    last.ts = ts;
    return;
  }
  const count = timeline.filter((entry) => entry.kind === "text").length;
  timeline.push({
    kind: "text",
    id: `text_${count + 1}`,
    ts,
    text: piece,
    status: "streaming",
  });
}

function findToolEntry(timeline, id) {
  // Reverse scan: updates almost always target the newest tool.
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.kind === "tool" && item.id === id) return item;
  }
  return null;
}

/** The todo/task-list is ONE evolving list, but OpenCode emits a fresh todowrite
 *  call (new callID) for every update. Coalesce them onto a single timeline entry
 *  so the task-list card updates in place instead of stacking a new card each time. */
function isTodoTool(name) {
  return String(name || "").toLowerCase() === "todowrite";
}
function findTodoEntry(timeline) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.kind === "tool" && isTodoTool(item.name)) return item;
  }
  return null;
}

export function upsertTimelineTool(target, tool, ts = Date.now()) {
  if (!tool?.id) return;
  const timeline = ensureTimeline(target);
  // todowrite updates all land on the first todo entry (its id stays stable so the
  // renderer reuses the same card); other tools key by their own call id.
  let entry = isTodoTool(tool.name) ? findTodoEntry(timeline) : findToolEntry(timeline, tool.id);
  if (!entry) {
    closeStreamingBlocks(target, ts);
    entry = {
      kind: "tool",
      id: tool.id,
      ts,
      startTs: ts,
      name: tool.name || "Tool",
      preview: toolPreview(tool),
      input: tool.input || {},
      partialJson: tool.partialJson || "",
      status: tool.status || "running",
      result: tool.result || null,
      metadata: tool.metadata || {},
      title: tool.title || "",
      parentToolUseId: tool.parentToolUseId || null,
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
  if (tool.metadata) entry.metadata = tool.metadata;
  if (tool.title) entry.title = tool.title;
  entry.preview = entry.input && Object.keys(entry.input).length > 0
    ? toolPreview({ ...entry, partialJson: "" })
    : toolPreview(entry);
  if (entry.status === "running" && tool.input && Object.keys(tool.input).length > 0) {
    setActivityLabel(target, entry.preview);
  }
}

export function appendTimelineNotice(target, notice, ts = Date.now()) {
  if (!notice || notice.panel === false) return;
  if (notice.code === "thinkingProgress" || isTokenCountDetail(notice.detail)) return;
  const timeline = ensureTimeline(target);
  const entry = {
    kind: "notice",
    ts,
    code: notice.code || "",
    level: notice.level || "info",
    detail: notice.detail || notice.message || "",
    done: Boolean(notice.done),
    replace: Boolean(notice.replace),
    replacesCode: notice.replacesCode || "",
  };
  if (notice.replace) {
    const replaceCode = String(notice.replacesCode || notice.code || "");
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const existing = timeline[index];
      if (existing?.kind !== "notice") continue;
      const existingCode = String(existing.code || "");
      const existingReplaceCode = String(existing.replacesCode || "");
      if (
        existingCode === replaceCode ||
        existingCode === entry.code ||
        existingReplaceCode === replaceCode
      ) {
        timeline[index] = { ...existing, ...entry };
        return;
      }
    }
  }
  timeline.push(entry);
}

export function applyProcessEventToTimeline(target, payload, ts = Date.now()) {
  const label = activityFromProcessPayload(payload);
  if (label && !runningToolActivity(target.tools)) setActivityLabel(target, label);
}

function runningToolActivity(tools) {
  if (!tools) return null;
  const values = tools instanceof Map ? tools.values() : tools;
  for (const tool of values) {
    if (tool?.status === "running") return toolPreview(tool);
  }
  return null;
}

export function hasRunningTool(tools) {
  return Boolean(runningToolActivity(tools));
}

export function resolveRunningToolLabel(liveTurn = {}) {
  return runningToolActivity(liveTurn.tools);
}

export function resolveActivityLabel(liveTurn = {}) {
  const running = runningToolActivity(liveTurn.tools);
  if (running) return running;
  if (isMeaningfulActivityLabel(liveTurn.activityLabel)) return liveTurn.activityLabel;
  return null;
}

function filterRenderableTimeline(timeline = []) {
  // The newest text block renders as the answer bubble; earlier text blocks
  // stay in the timeline so prose written between tools keeps its place.
  let lastTextIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "text") {
      lastTextIndex = index;
      break;
    }
  }
  return timeline.filter((entry, index) => {
    if (entry.kind === "text") {
      return index !== lastTextIndex && Boolean(String(entry.text || "").trim());
    }
    if (entry.kind !== "notice") return true;
    if (entry.code === "thinkingProgress") return false;
    if (isTokenCountDetail(entry.detail)) return false;
    return Boolean(resolveNoticeDetail(entry));
  });
}

export function getRenderableTimeline(liveTurn = {}) {
  if (liveTurn.timeline?.length) return filterRenderableTimeline(liveTurn.timeline);
  return filterRenderableTimeline(buildTimelineFromLegacy(liveTurn));
}

export function buildTimelineFromLegacy(state = {}) {
  const timeline = [];
  const ts = state.startedAt || Date.now();
  if (state.thinkingText?.trim()) {
    timeline.push({
      kind: "thinking",
      id: "think_1",
      ts,
      text: state.thinkingText.trim(),
      collapsed: true,
      status: "done",
    });
  }
  const tools = state.tools instanceof Map ? [...state.tools.values()] : (state.tools || []);
  for (const tool of tools) {
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
      metadata: tool.metadata || {},
      title: tool.title || "",
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
      done: Boolean(notice.done),
      replace: Boolean(notice.replace),
      replacesCode: notice.replacesCode || "",
    });
  }
  return timeline;
}

export function resetTimelineFields(target) {
  target.timeline = [];
  target.activityLabel = null;
  target.durationMs = null;
  target.totalCostUsd = null;
}
