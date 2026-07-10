import { getRenderableTimeline } from "./turn-renderable-timeline.js";
import { classifyToolCategory, isTodoTool } from "./turn-tool-model.js";

export function partitionTimeline(timeline = []) {
  const thinking = [];
  const notices = [];
  const tools = [];
  const texts = [];
  for (const entry of timeline) {
    if (entry.kind === "thinking") thinking.push(entry);
    else if (entry.kind === "notice") notices.push(entry);
    else if (entry.kind === "tool" || entry.kind === "toolGroup") tools.push(entry);
    else if (entry.kind === "text") texts.push(entry);
  }
  return { thinking, notices, tools, texts };
}

export function shouldCollapseProcessGroups(liveTurn = {}, sealed = false) {
  const { tools, notices } = partitionTimeline(getRenderableTimeline(liveTurn));
  if (!sealed) return false;
  return tools.length >= 2 || (tools.length >= 1 && notices.length >= 1);
}

// Liveness notices are TRANSIENT by definition ("write 正在运行 · 已运行 33s"):
// they keep their light is-liveness rendering, but only WHILE the state they
// describe is still true — a toolProgress line disappears the moment no tool
// is running, a longWait line the moment anything newer lands, and neither
// ever reaches the sealed transcript (a saved "still running" would be a
// permanently false statement in history).
export const LIVENESS_NOTICE_CODES = new Set(["toolProgress", "longWait"]);

function hasRunningToolEntry(liveTurn = {}) {
  const tools = liveTurn.tools;
  const values = tools instanceof Map ? [...tools.values()] : Array.isArray(tools) ? tools : [];
  return values.some((tool) => tool?.status === "running");
}

function livenessNoticeVisible(entry, { liveTurn, sealed, isLast }) {
  if (sealed) return false;
  if (entry.code === "toolProgress") return hasRunningToolEntry(liveTurn);
  return isLast;
}

export function timelineForProcessView(liveTurn, sealed) {
  const timeline = getRenderableTimeline(liveTurn);
  const lastIndex = timeline.length - 1;
  return collapseRepeatedReadTools(timeline.filter((entry, index) => {
    if (entry.kind === "notice" && LIVENESS_NOTICE_CODES.has(entry.code)) {
      return livenessNoticeVisible(entry, { liveTurn, sealed: Boolean(sealed), isLast: index === lastIndex });
    }
    return sealed || entry.kind !== "notice" || entry.level === "progress";
  }));
}

function canGroupReadTool(entry = {}) {
  return entry.kind === "tool" &&
    classifyToolCategory(entry.name) === "read" &&
    !entry.parentToolUseId &&
    !isTodoTool(entry.name);
}

function groupedStatus(entries = []) {
  if (entries.some((entry) => entry.status === "running")) return "running";
  if (entries.some((entry) => entry.status === "failed")) return "failed";
  return entries.at(-1)?.status || "done";
}

export function collapseRepeatedReadTools(timeline = [], minCount = 2) {
  const out = [];
  for (let index = 0; index < timeline.length;) {
    const entry = timeline[index];
    if (!canGroupReadTool(entry)) {
      out.push(entry);
      index += 1;
      continue;
    }
    const run = [];
    while (index < timeline.length && canGroupReadTool(timeline[index])) {
      run.push(timeline[index]);
      index += 1;
    }
    if (run.length < minCount) {
      out.push(...run);
      continue;
    }
    const first = run[0];
    const last = run[run.length - 1];
    out.push({
      kind: "toolGroup",
      id: `read_group_${first.id || "first"}_${last.id || run.length}`,
      name: "read",
      category: "read",
      status: groupedStatus(run),
      ts: last.ts,
      startTs: first.startTs || first.ts,
      tools: run,
    });
  }
  return out;
}
