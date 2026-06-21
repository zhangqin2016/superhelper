#!/usr/bin/env node
import module from "node:module";

const require = module.createRequire(import.meta.url);
const {
  activityFromProcessPayload,
  activityFromEngineNotice,
  appendTimelineNotice,
  appendTimelineText,
  buildTimelineFromLegacy,
  closeOpenThinkingBlocks,
  closeStreamingBlocks,
  isMeaningfulActivityLabel,
  setActivityLabel,
  upsertTimelineThinking,
  upsertTimelineTool,
} = require("../src/main/turn-timeline.js");

const statusPayload = {
  rawSubtype: "status",
  event: { status: "Reading recent chapters" },
  actions: [],
};
if (activityFromProcessPayload(statusPayload) !== "Reading recent chapters") {
  throw new Error("status activity extraction failed");
}
if (activityFromProcessPayload({ rawSubtype: "status", event: { status: "requesting" } })) {
  throw new Error("requesting should not become activity");
}
if (!isMeaningfulActivityLabel("Writing chapter 41")) {
  throw new Error("task label should be meaningful");
}

const taskNotice = activityFromEngineNotice({
  code: "taskProgress",
  detail: "Writing chapter 41",
  panel: true,
});
if (taskNotice !== null) {
  throw new Error(`task progress must not drive status line: ${taskNotice}`);
}
if (activityFromEngineNotice({ code: "thinkingProgress", detail: "44 tokens" })) {
  throw new Error("thinking token telemetry should not become activity");
}

const systemNoticePayload = {
  rawSubtype: "task_started",
  summary: "system_notice",
  actions: [{
    kind: "system_notice",
    notice: { code: "taskStarted", detail: "正在写第 90 章", panel: false },
  }],
  event: { type: "system", subtype: "task_started" },
};
if (activityFromProcessPayload(systemNoticePayload) !== null) {
  throw new Error(`task system_notice must not drive status line: ${activityFromProcessPayload(systemNoticePayload)}`);
}
if (isMeaningfulActivityLabel("system_notice")) {
  throw new Error("system_notice must not be a meaningful activity label");
}

const progressState = { timeline: [] };
appendTimelineNotice(progressState, {
  code: "taskProgress",
  level: "progress",
  panel: true,
  replace: true,
  detail: "Uploading 10%",
}, 900);
appendTimelineNotice(progressState, {
  code: "taskProgress",
  level: "progress",
  panel: true,
  replace: true,
  detail: "Uploading 42%",
}, 901);
if (progressState.timeline.length !== 1 || progressState.timeline[0].detail !== "Uploading 42%") {
  throw new Error(`task progress should replace in place: ${JSON.stringify(progressState.timeline)}`);
}
appendTimelineNotice(progressState, {
  code: "taskCompleted",
  level: "info",
  panel: true,
  replace: true,
  replacesCode: "taskProgress",
  done: true,
  detail: "Upload complete",
}, 902);
if (
  progressState.timeline.length !== 1 ||
  progressState.timeline[0].code !== "taskCompleted" ||
  progressState.timeline[0].detail !== "Upload complete" ||
  progressState.timeline[0].done !== true
) {
  throw new Error(`task completion should replace progress: ${JSON.stringify(progressState.timeline)}`);
}

const state = { timeline: [], activityLabel: null, tools: new Map() };
setActivityLabel(state, "Reading recent chapters");
upsertTimelineThinking(state, "Plan the patch.", 1000);
upsertTimelineTool(state, {
  id: "tool_1",
  name: "Read",
  input: { file_path: "src/a.js" },
  status: "running",
}, 1001);
upsertTimelineTool(state, {
  id: "tool_1",
  status: "done",
  result: { content: "ok" },
}, 1002);

if (state.timeline.length !== 2) {
  throw new Error(`expected thinking + tool timeline entries, got ${state.timeline.length}`);
}
if (state.activityLabel !== "Read src/a.js") {
  throw new Error(`running tool should become activity label: ${state.activityLabel}`);
}

// Interleaved thinking must produce ordered blocks (think → act → think again),
// matching the engine's content-block stream. A merged single blob would lose
// the chronological narrative the turn view renders.
const interleaved = { timeline: [], activityLabel: null, tools: new Map() };
upsertTimelineThinking(interleaved, "first ", 2000);
upsertTimelineThinking(interleaved, "thought", 2001);
upsertTimelineTool(interleaved, {
  id: "t1",
  name: "Read",
  input: { file_path: "a.js" },
  status: "running",
}, 2002);
upsertTimelineThinking(interleaved, "second thought", 2003);
if (interleaved.timeline.length !== 3) {
  throw new Error(`interleaved thinking must create separate blocks: ${JSON.stringify(interleaved.timeline)}`);
}
const [firstThink, , secondThink] = interleaved.timeline;
if (firstThink.text !== "first thought") {
  throw new Error(`thinking deltas must append within an open block: ${firstThink.text}`);
}
if (firstThink.status !== "done") {
  throw new Error("starting a tool must seal the open thinking block");
}
if (firstThink.id !== "think_1" || secondThink.id !== "think_2") {
  throw new Error(`thinking blocks need stable ids for DOM patching: ${firstThink.id}/${secondThink.id}`);
}
if (secondThink.status !== "streaming") {
  throw new Error("latest thinking block must stay open while streaming");
}

// Out-of-band notices (e.g. apiRetry) are not content blocks and must not
// split a thinking block in two.
appendTimelineNotice(interleaved, { code: "apiRetry", level: "warning", panel: true, detail: "retrying" }, 2004);
upsertTimelineThinking(interleaved, " continues", 2005);
if (interleaved.timeline.filter((entry) => entry.kind === "thinking").length !== 2) {
  throw new Error("a notice must not split the open thinking block");
}
if (secondThink.text !== "second thought continues") {
  throw new Error(`thinking must continue across notices: ${secondThink.text}`);
}

// message_stop / finalize close the open block; the next delta starts a new one.
closeOpenThinkingBlocks(interleaved, 2006);
if (secondThink.status !== "done") {
  throw new Error("closeOpenThinkingBlocks must seal streaming blocks");
}
upsertTimelineThinking(interleaved, "third", 2007);
if (interleaved.timeline.filter((entry) => entry.kind === "thinking").length !== 3) {
  throw new Error("a delta after close must open a fresh thinking block");
}

// Assistant prose is a content block too: the timeline must keep the full
// think → answer → act → answer order so live view and archive share one model.
const blockTurn = { timeline: [], activityLabel: null, tools: new Map() };
upsertTimelineThinking(blockTurn, "plan", 3000);
appendTimelineText(blockTurn, "Here is ", 3001);
appendTimelineText(blockTurn, "the answer.", 3002);
if (blockTurn.timeline.length !== 2) {
  throw new Error(`expected thinking + text blocks: ${JSON.stringify(blockTurn.timeline)}`);
}
if (blockTurn.timeline[0].status !== "done") {
  throw new Error("a text delta must seal the open thinking block");
}
const textBlock = blockTurn.timeline[1];
if (textBlock.kind !== "text" || textBlock.id !== "text_1" || textBlock.text !== "Here is the answer.") {
  throw new Error(`text deltas must merge into one streaming block: ${JSON.stringify(textBlock)}`);
}
upsertTimelineThinking(blockTurn, "more thought", 3003);
if (textBlock.status !== "done") {
  throw new Error("a thinking delta must seal the open text block");
}
upsertTimelineTool(blockTurn, { id: "t9", name: "Bash", input: { command: "ls" }, status: "running" }, 3004);
appendTimelineText(blockTurn, "Done.", 3005);
const blockKinds = blockTurn.timeline.map((entry) => entry.kind).join(",");
if (blockKinds !== "thinking,text,thinking,tool,text") {
  throw new Error(`blocks must stay in chronological order: ${blockKinds}`);
}
if (blockTurn.timeline[4].id !== "text_2") {
  throw new Error(`second prose block needs its own id: ${blockTurn.timeline[4].id}`);
}
closeStreamingBlocks(blockTurn, 3006);
if (blockTurn.timeline.some((entry) => entry.status === "streaming")) {
  throw new Error("closeStreamingBlocks must seal every open block");
}

// Subagent child tools carry their parent id so the renderer can nest them
// under the Task card instead of flooding the main timeline.
const subagentTurn = { timeline: [], activityLabel: null, tools: new Map() };
upsertTimelineTool(subagentTurn, { id: "task_1", name: "Task", input: { prompt: "explore" }, status: "running" }, 4000);
upsertTimelineTool(subagentTurn, {
  id: "read_1",
  name: "Read",
  input: { file_path: "a.js" },
  status: "running",
  parentToolUseId: "task_1",
}, 4001);
const childEntry = subagentTurn.timeline.find((entry) => entry.id === "read_1");
if (childEntry?.parentToolUseId !== "task_1") {
  throw new Error(`tool entries must keep parentToolUseId: ${JSON.stringify(childEntry)}`);
}
// Tool entries carry startTs so the UI can show per-tool duration once done.
if (childEntry.startTs !== 4001) {
  throw new Error(`tool entries must record their start time: ${childEntry.startTs}`);
}
upsertTimelineTool(subagentTurn, { id: "read_1", status: "done", result: { content: "ok" } }, 5500);
if (childEntry.startTs !== 4001 || childEntry.ts !== 5500) {
  throw new Error(`tool completion must keep startTs and update ts: ${childEntry.startTs}/${childEntry.ts}`);
}

const legacy = buildTimelineFromLegacy({
  startedAt: 1,
  thinkingText: "legacy thought",
  tools: new Map([["t1", { id: "t1", name: "Bash", input: { command: "npm test" }, status: "done" }]]),
  notices: [{ payload: { notice: { code: "permissionDenied", level: "warning", panel: true, detail: "denied" } } }],
});
if (legacy.length !== 3) {
  throw new Error(`legacy rebuild failed: ${legacy.length}`);
}

// todowrite updates coalesce into ONE timeline entry (the task-list card updates
// in place) instead of stacking a new card per update; other tools stay separate.
{
  const s = { timeline: [], activityLabel: null, tools: new Map() };
  upsertTimelineTool(s, { id: "todo_1", name: "todowrite", status: "completed",
    input: { todos: [{ content: "A", status: "completed" }, { content: "B", status: "pending" }] } }, 1);
  upsertTimelineTool(s, { id: "todo_2", name: "todowrite", status: "completed",
    input: { todos: [{ content: "A", status: "completed" }, { content: "B", status: "completed" }] } }, 2);
  upsertTimelineTool(s, { id: "bash_1", name: "bash", status: "completed", input: { command: "ls" } }, 3);
  const todos = s.timeline.filter((e) => e.kind === "tool" && String(e.name).toLowerCase() === "todowrite");
  if (todos.length !== 1) throw new Error(`todowrite must coalesce to one entry, got ${todos.length}`);
  if (todos[0].id !== "todo_1") throw new Error(`coalesced todo keeps the first id (stable card), got ${todos[0].id}`);
  if (todos[0].input.todos[1].status !== "completed") throw new Error("coalesced todo must show the latest list state");
  if (s.timeline.filter((e) => e.kind === "tool").length !== 2) throw new Error("non-todo tool must stay a separate entry");
}

console.log("turn-timeline: ok");
