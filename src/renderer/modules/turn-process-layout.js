/**
 * CLI TUI-aligned process layout: tool grouping, dedup, and visibility rules.
 */

import { getRenderableTimeline, toolPreview } from "./turn-timeline.js";

const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);
const READ_TOOLS = new Set(["read"]);
const SEARCH_TOOLS = new Set(["grep", "glob"]);
const COMMAND_TOOLS = new Set(["bash"]);
const WEB_TOOLS = new Set(["websearch", "webfetch"]);
const AGENT_TOOLS = new Set(["task"]);

export function classifyToolCategory(name = "") {
  const n = String(name).toLowerCase();
  if (READ_TOOLS.has(n)) return "read";
  if (WRITE_TOOLS.has(n)) return "write";
  if (SEARCH_TOOLS.has(n)) return "search";
  if (COMMAND_TOOLS.has(n)) return "command";
  if (WEB_TOOLS.has(n)) return "web";
  if (AGENT_TOOLS.has(n)) return "agent";
  return "other";
}

export function partitionTimeline(timeline = []) {
  const thinking = [];
  const notices = [];
  const tools = [];
  for (const entry of timeline) {
    if (entry.kind === "thinking") thinking.push(entry);
    else if (entry.kind === "notice") notices.push(entry);
    else if (entry.kind === "tool") tools.push(entry);
  }
  return { thinking, notices, tools };
}

export function groupToolsByCategory(tools = []) {
  const groups = new Map();
  for (const tool of tools) {
    const cat = classifyToolCategory(tool.name);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(tool);
  }
  return groups;
}

export function normalizeForDedup(text = "") {
  return String(text).trim().replace(/\s+/g, " ");
}

export function collectFileToolBodies(liveTurn = {}) {
  const bodies = [];
  for (const entry of getRenderableTimeline(liveTurn)) {
    if (entry.kind !== "tool") continue;
    const cat = classifyToolCategory(entry.name);
    if (cat !== "write") continue;
    const input = entry.input || {};
    for (const key of ["content", "new_string"]) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) {
        bodies.push(normalizeForDedup(value));
      }
    }
  }
  return bodies;
}

export function textMatchesFileToolBody(text, liveTurn = {}) {
  const normalized = normalizeForDedup(text);
  if (!normalized) return false;
  const bodies = collectFileToolBodies(liveTurn);
  return bodies.some((body) => body === normalized || body.includes(normalized) || normalized.includes(body));
}

export function shouldShowNarrative(liveTurn = {}) {
  const text = (liveTurn.assistantText || "").trim();
  if (!text) return false;
  if (Boolean(liveTurn.final)) return false;
  if (textMatchesFileToolBody(text, liveTurn)) return false;
  return true;
}

export function resolveFinalText(liveTurn = {}) {
  return String(liveTurn.final?.payload?.assistant || liveTurn.assistantText || "").trim();
}

export function shouldShowFinal(liveTurn = {}) {
  const finalText = resolveFinalText(liveTurn);
  if (!finalText) return false;
  if (textMatchesFileToolBody(finalText, liveTurn)) return false;

  const { tools } = partitionTimeline(getRenderableTimeline(liveTurn));
  const writeTools = tools.filter((t) => classifyToolCategory(t.name) === "write");
  if (writeTools.length > 0 && tools.length === writeTools.length) {
    const shortAck = finalText.length <= 240 && !finalText.includes("\n\n");
    if (shortAck) return false;
  }
  return true;
}

export function shouldCollapseProcessGroups(liveTurn = {}, sealed = false) {
  const { tools, notices } = partitionTimeline(getRenderableTimeline(liveTurn));
  if (!sealed) return false;
  return tools.length >= 2 || (tools.length >= 1 && notices.length >= 1);
}

export function processGroupSummary(tools = [], notices = [], translate) {
  const parts = [];
  if (tools.length) {
    parts.push(translate("timeline.stepsCompleted", { count: tools.length }));
  }
  if (notices.length) {
    parts.push(translate("timeline.processNotices", { count: notices.length }));
  }
  return parts.join(" · ");
}

export function categorySummaryKey(category, count) {
  if (category === "read") return ["timeline.summaryRead", { count }];
  if (category === "write") return ["timeline.summaryWrite", { count }];
  if (category === "search") return ["timeline.summarySearch", { count }];
  if (category === "command") return ["timeline.summaryCommand", { count }];
  if (category === "web") return ["timeline.summaryWeb", { count }];
  if (category === "agent") return ["timeline.summaryAgent", { count }];
  return ["timeline.summaryOther", { count }];
}

export function toolEntryToRenderTool(entry = {}) {
  return {
    id: entry.id,
    name: entry.name,
    input: entry.input || {},
    partialJson: entry.partialJson || "",
    status: entry.status || "done",
    result: entry.result || null,
  };
}

export function toolRowPreview(entry = {}) {
  return entry.preview || toolPreview(toolEntryToRenderTool(entry));
}

export function isFileWriteCategory(entry = {}) {
  return classifyToolCategory(entry.name) === "write";
}
