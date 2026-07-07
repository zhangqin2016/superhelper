import {
  isMeaningfulActivityLabel,
  setActivityLabel,
} from "./turn-activity-policy.js";
import { closeStreamingBlocks } from "./turn-streaming-blocks.js";
import { toolPreview } from "./turn-tool-preview.js";

function ensureTimeline(target) {
  if (!Array.isArray(target.timeline)) target.timeline = [];
  return target.timeline;
}

function findToolEntry(timeline, id) {
  // Reverse scan: updates almost always target the newest tool.
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.kind === "tool" && item.id === id) return item;
  }
  return null;
}

// The todo/task-list is one evolving list, but OpenCode emits a fresh
// todowrite call for every update. Coalesce them onto one stable timeline card.
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
