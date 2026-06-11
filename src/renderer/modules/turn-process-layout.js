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

const TODO_TOOLS = new Set(["todowrite"]);

export function isTodoTool(name = "") {
  return TODO_TOOLS.has(String(name).toLowerCase());
}

// TodoWrite input is the model's plan; statuses outside the known set
// degrade to pending so a malformed item never hides the plan.
export function parseTodoEntries(tool = {}) {
  let input = tool.input;
  if ((!input || !Array.isArray(input.todos)) && tool.partialJson) {
    try {
      input = JSON.parse(tool.partialJson);
    } catch {
      return [];
    }
  }
  const todos = Array.isArray(input?.todos) ? input.todos : [];
  return todos
    .map((todo) => ({
      content: String(todo?.content || todo?.activeForm || "").trim(),
      status: todo?.status === "completed" || todo?.status === "in_progress" ? todo.status : "pending",
    }))
    .filter((todo) => todo.content);
}

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
  const texts = [];
  for (const entry of timeline) {
    if (entry.kind === "thinking") thinking.push(entry);
    else if (entry.kind === "notice") notices.push(entry);
    else if (entry.kind === "tool") tools.push(entry);
    else if (entry.kind === "text") texts.push(entry);
  }
  return { thinking, notices, tools, texts };
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

const CLI_ASSISTANT_TERMINALS = new Set([
  "turn.stalled",
  "turn.interrupted",
  "turn.failed",
]);

/** Assistant text the CLI actually streamed or committed — no synthesis from tools. */
export function lastTimelineText(liveTurn = {}) {
  const timeline = Array.isArray(liveTurn.timeline) ? liveTurn.timeline : [];
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "text") return String(timeline[index].text || "").trim();
  }
  return null;
}

export function resolveAssistantStreamText(liveTurn = {}) {
  const blockText = lastTimelineText(liveTurn);
  if (liveTurn.final?.payload?.assistant != null) {
    const finalText = String(liveTurn.final.payload.assistant).trim();
    // The final payload is the full streamed aggregation unless something
    // (e.g. an injected error message) overrode it. When it is just the
    // aggregation, show only the last prose block — earlier blocks render
    // inline in the timeline and must not duplicate here.
    if (blockText && finalText.endsWith(blockText)) return blockText;
    return finalText;
  }
  if (blockText != null) return blockText;
  return String(liveTurn.assistantText || "").trim();
}

export function shouldShowNarrative(liveTurn = {}) {
  const text = resolveAssistantStreamText(liveTurn);
  if (!text) return false;
  if (Boolean(liveTurn.final)) {
    if (liveTurn.final.type === "turn.completed") {
      if (hasCliResult(liveTurn)) return false;
      return !textMatchesFileToolBody(text, liveTurn);
    }
    if (CLI_ASSISTANT_TERMINALS.has(liveTurn.final.type)) {
      return !textMatchesFileToolBody(text, liveTurn);
    }
    return false;
  }
  if (textMatchesFileToolBody(text, liveTurn)) return false;
  return true;
}

export function resolveFinalText(liveTurn = {}) {
  return resolveAssistantStreamText(liveTurn);
}

/** True only when CLI emitted a `result` event for this turn. */
export function hasCliResult(liveTurn = {}) {
  return liveTurn.final?.payload?.resultFromCli === true;
}

export function shouldShowFinal(liveTurn = {}) {
  if (liveTurn.final?.type !== "turn.completed") return false;
  if (!hasCliResult(liveTurn)) return false;
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
  return toolPreview(toolEntryToRenderTool(entry));
}

export function isFileWriteCategory(entry = {}) {
  return classifyToolCategory(entry.name) === "write";
}
