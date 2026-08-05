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

function normalizeSealedProcessTimeline(timeline = []) {
  const out = [];
  let todoIndex = -1;
  for (const raw of timeline) {
    if (!raw || typeof raw !== "object") continue;
    const entry = { ...raw };
    if ((entry.kind === "thinking" || entry.kind === "text") && entry.status === "streaming") {
      entry.status = "done";
    }
    if (entry.kind === "tool" && isTodoTool(entry.name)) {
      if (todoIndex >= 0) out.splice(todoIndex, 1);
      out.push(entry);
      todoIndex = out.length - 1;
      continue;
    }
    out.push(entry);
  }
  return out;
}

function hasRunningToolEntry(liveTurn = {}) {
  const tools = liveTurn.tools;
  const values = tools instanceof Map ? [...tools.values()] : Array.isArray(tools) ? tools : [];
  return values.some((tool) => tool?.status === "running");
}

function livenessNoticeVisible(entry, { liveTurn, sealed, hasNewerMeaningfulEntry }) {
  if (sealed) return false;
  if (entry.code === "toolProgress") return hasRunningToolEntry(liveTurn);
  return !hasNewerMeaningfulEntry;
}

function isMeaningfulAfterLiveness(entry = {}) {
  // Thinking is model activity, not a user-visible work transition. A stream
  // of hidden reasoning must not cover the only indication that the turn is
  // still alive. Tool/text/normal notices do represent a newer visible step.
  if (entry.kind === "thinking") return false;
  if (entry.kind === "notice" && LIVENESS_NOTICE_CODES.has(entry.code)) return false;
  if (entry.kind === "text") return Boolean(String(entry.text || "").trim());
  return true;
}

function isLegacyDiscardSinkProgress(entry = {}) {
  if (entry.kind !== "notice" || entry.code !== "workProgress" || entry.level !== "progress" || entry.progress) return false;
  const detail = String(entry.detail || "");
  if (!detail.startsWith("Download: ")) return false;
  const target = detail.slice("Download: ".length);
  return target === "/dev/null" || /^(?:nul:?|\$null)$/i.test(target);
}

export function timelineForProcessView(liveTurn, sealed) {
  const timeline = sealed
    ? normalizeSealedProcessTimeline(getRenderableTimeline(liveTurn))
    : getRenderableTimeline(liveTurn);
  const newestMeaningfulIndex = timeline.reduce(
    (latest, entry, index) => isMeaningfulAfterLiveness(entry) ? index : latest,
    -1,
  );
  return collapseRepeatedReadTools(timeline.filter((entry, index) => {
    if (sealed && isLegacyDiscardSinkProgress(entry)) return false;
    if (entry.kind === "notice" && LIVENESS_NOTICE_CODES.has(entry.code)) {
      return livenessNoticeVisible(entry, {
        liveTurn,
        sealed: Boolean(sealed),
        hasNewerMeaningfulEntry: newestMeaningfulIndex > index,
      });
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
