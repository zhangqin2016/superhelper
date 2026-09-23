import { isTodoTool } from "./turn-tool-model.js";

export function buildChildToolsMap(toolEntries = []) {
  const ids = new Set(toolEntries.map((entry) => entry.id));
  const children = new Map();
  for (const entry of toolEntries) {
    const parent = entry.parentToolUseId;
    if (!parent || !ids.has(parent) || parent === entry.id) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(entry);
  }
  return children;
}

export function isSubagentEntry(entry = {}) {
  return String(entry.name || "").toLowerCase() === "task";
}

export function shouldSkipProcessTimelineEntry(entry = {}, { childToolIds = new Set() } = {}) {
  return entry.kind === "tool" && (childToolIds.has(entry.id) || isSubagentEntry(entry));
}

// Prose written between tools narrates the work while it runs. Once the turn
// is sealed and its steps are folded, that narration is part of the process it
// described — left in place, it reads as the assistant still talking above an
// answer that already covers it. It folds with the steps; with no step group to
// fold into, it keeps its place.
export function shouldRenderEntryInCollapsedProcess(entry = {}, { foldNarration = false } = {}) {
  if (entry.kind === "text") return !foldNarration;
  return entry.kind === "thinking" ||
    (entry.kind === "tool" && isTodoTool(entry.name));
}

export function hasProcessGroupSteps({ processTools = [], notices = [] } = {}) {
  return processTools.length > 0 || notices.length > 0;
}

export function shouldRenderThinkingStackForEntry(entry = {}, { groupThinking = false } = {}) {
  return Boolean(groupThinking) && entry.kind === "thinking";
}

export function shouldAppendCollapsedProcessGroupFallback({
  groupInserted = false,
  processTools = [],
  notices = [],
} = {}) {
  return !groupInserted && hasProcessGroupSteps({ processTools, notices });
}

export function collectSubagentEntries(timeline = [], liveTurn = null) {
  const bySession = new Map();
  const entries = [];
  for (const entry of timeline.filter((item) => item.kind === "tool" && isSubagentEntry(item))) {
    const sessionId = entry.metadata?.sessionId || entry.metadata?.sessionID || "";
    const sub = sessionId ? liveTurn?.subagents?.get?.(sessionId) : null;
    const merged = sub ? { ...entry, subagent: sub } : entry;
    entries.push(merged);
    if (sessionId) bySession.set(sessionId, merged);
  }
  for (const sub of liveTurn?.subagents?.values?.() || []) {
    if (bySession.has(sub.sessionId)) continue;
    entries.push({
      kind: "tool",
      id: sub.parentToolId || sub.sessionId,
      name: "task",
      input: { description: sub.description, subagent_type: sub.label },
      status: sub.status === "done" ? "done" : sub.status,
      metadata: sub.metadata || { sessionId: sub.sessionId },
      title: sub.description || "",
      subagent: sub,
    });
  }
  return entries;
}
