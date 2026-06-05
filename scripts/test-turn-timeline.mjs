#!/usr/bin/env node
import module from "node:module";

const require = module.createRequire(import.meta.url);
const {
  activityFromProcessPayload,
  activityFromEngineNotice,
  buildTimelineFromLegacy,
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
  panel: false,
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

const legacy = buildTimelineFromLegacy({
  startedAt: 1,
  thinkingText: "legacy thought",
  tools: new Map([["t1", { id: "t1", name: "Bash", input: { command: "npm test" }, status: "done" }]]),
  notices: [{ payload: { notice: { code: "permissionDenied", level: "warning", panel: true, detail: "denied" } } }],
});
if (legacy.length !== 3) {
  throw new Error(`legacy rebuild failed: ${legacy.length}`);
}

console.log("turn-timeline: ok");
