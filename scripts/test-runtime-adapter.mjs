#!/usr/bin/env node
/**
 * Runtime adapter contract: vendor-specific CLI events must become stable
 * RuntimeEvent drafts for the single runtime-events pipeline.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CliEventAdapter } = require("../src/main/runtime/adapters/claude-cli-adapter.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const fixtureDir = path.join(repoRoot, "fixtures", "claude-runtime");

function readJsonl(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`${path.basename(file)}:${index + 1} invalid JSON: ${err.message}`);
      }
    });
}

function flatten(file) {
  const adapter = new CliEventAdapter();
  return readJsonl(path.join(fixtureDir, file)).flatMap((event) => {
    const normalized = adapter.normalizeEvent(event);
    return normalized.runtimeEvents;
  });
}

function hasType(events, type) {
  return events.some((event) => event.type === type);
}

const basicEvents = flatten("basic-text.jsonl");
if (!hasType(basicEvents, "assistant.delta")) {
  throw new Error(`basic-text must expose assistant.delta, got ${basicEvents.map((e) => e.type).join(",")}`);
}

const toolEvents = flatten("tool-use.jsonl");
for (const type of ["tool.started", "tool.input.delta", "tool.done"]) {
  if (!hasType(toolEvents, type)) {
    throw new Error(`tool-use must expose ${type}, got ${toolEvents.map((e) => e.type).join(",")}`);
  }
}

const permissionAdapter = new CliEventAdapter();
const permissionNormalized = readJsonl(path.join(fixtureDir, "control-permission.jsonl"))
  .flatMap((event) => permissionAdapter.normalizeEvent(event).actions);
if (!permissionNormalized.some((action) => action.kind === "permission_check")) {
  throw new Error("permission control request must normalize to permission_check action");
}

const hookNameNormalized = permissionAdapter.normalizeEvent({
  type: "control_request",
  request_id: "hook_1",
  request: {
    type: "hook",
    hook_event: {
      hook_event_name: "TaskCreated",
      task_id: "task_1",
      task_name: "scan website",
    },
  },
}).actions;
if (!hookNameNormalized.some((action) => action.kind === "hook_task_created" && action.hookName === "TaskCreated")) {
  throw new Error(`hook_event_name must normalize to hook_task_created, got ${JSON.stringify(hookNameNormalized)}`);
}

const taskEvents = flatten("task-progress.jsonl");
if (!hasType(taskEvents, "engine.notice")) {
  throw new Error("task telemetry must expose engine.notice");
}

const unknownEvents = flatten("unknown-runtime.jsonl");
if (!hasType(unknownEvents, "protocol.unknown")) {
  throw new Error("unknown vendor events must degrade to protocol.unknown");
}

const pythonGameEvents = flatten("python-game-probe.jsonl");
for (const type of ["assistant.thinking.delta", "tool.started", "tool.done", "assistant.delta"]) {
  if (!hasType(pythonGameEvents, type)) {
    throw new Error(`python-game probe must expose ${type}, got ${pythonGameEvents.map((e) => e.type).join(",")}`);
  }
}
if (!hasType(pythonGameEvents, "assistant.delta")) {
  throw new Error(`python-game probe must expose assistant.delta, got ${pythonGameEvents.map((e) => e.type).join(",")}`);
}
if (pythonGameEvents.some((event) => event.type === "engine.warning")) {
  throw new Error("python-game probe must not produce engine.warning for known Claude CLI events");
}
const pythonText = pythonGameEvents
  .filter((event) => event.type === "assistant.delta")
  .map((event) => event.payload?.text || "")
  .join("");
if (pythonText !== "已创建并检查 number_game.py。") {
  throw new Error(`stream + top-level assistant text must render once, got ${JSON.stringify(pythonText)}`);
}

const adapter = new CliEventAdapter();
const background = adapter.normalizeEvent({
  type: "system",
  subtype: "task_progress",
  message: "Writing chapter",
});
if (!background.backgroundActivity || background.backgroundActivity.short) {
  throw new Error(`task_progress must keep runtime active, got ${JSON.stringify(background.backgroundActivity)}`);
}

const status = adapter.normalizeEvent({
  type: "system",
  subtype: "status",
  status: "Reading recent chapters",
});
if (!hasType(status.runtimeEvents, "engine.notice") || status.warnings.length !== 0) {
  throw new Error(`system/status must expose progress without warning, got ${JSON.stringify(status)}`);
}
if (!status.backgroundActivity || status.backgroundActivity.short) {
  throw new Error(`system/status must keep runtime active, got ${JSON.stringify(status.backgroundActivity)}`);
}

const toolProgress = adapter.normalizeEvent({
  type: "tool_progress",
  tool_name: "Bash",
  message: "Uploading layer 42%",
});
if (!hasType(toolProgress.runtimeEvents, "engine.notice")) {
  throw new Error(`tool_progress must expose engine.notice, got ${JSON.stringify(toolProgress.runtimeEvents)}`);
}
const toolProgressNotice = toolProgress.runtimeEvents.find((event) => event.type === "engine.notice")?.payload?.notice;
if (toolProgressNotice?.code !== "toolProgress" || toolProgressNotice?.panel !== true) {
  throw new Error(`tool_progress notice should be visible panel progress, got ${JSON.stringify(toolProgressNotice)}`);
}

const completed = adapter.normalizeEvent({
  type: "system",
  subtype: "task_completed",
  message: "Done",
});
if (!completed.backgroundActivity?.short) {
  throw new Error(`task_completed must shorten background activity, got ${JSON.stringify(completed.backgroundActivity)}`);
}

const init = adapter.normalizeEvent({
  type: "system",
  subtype: "init",
  session_id: "resume_1",
});
if (!hasType(init.runtimeEvents, "session.hydrated")) {
  throw new Error(`system/init must expose session.hydrated, got ${JSON.stringify(init.runtimeEvents)}`);
}

const usage = adapter.normalizeEvent({
  type: "stream_event",
  event: {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 5 },
  },
});
if (!hasType(usage.runtimeEvents, "usage.updated")) {
  throw new Error(`message_delta usage must expose usage.updated, got ${JSON.stringify(usage.runtimeEvents)}`);
}

const suggestions = adapter.normalizeEvent({
  type: "prompt_suggestions",
  suggestions: ["A", "B"],
});
if (!hasType(suggestions.runtimeEvents, "prompt_suggestions.updated")) {
  throw new Error(`prompt suggestions must expose prompt_suggestions.updated, got ${JSON.stringify(suggestions.runtimeEvents)}`);
}

console.log("runtime-adapter: ok");
