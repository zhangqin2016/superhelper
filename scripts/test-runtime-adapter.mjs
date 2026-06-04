#!/usr/bin/env node
/**
 * Runtime adapter contract: vendor-specific CLI events must become stable
 * runtime events while preserving compatibility actions for the current UI.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ClaudeCliAdapter } = require("../src/main/runtime/adapters/claude-cli-adapter.js");

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
  const adapter = new ClaudeCliAdapter();
  return readJsonl(path.join(fixtureDir, file)).flatMap((event) => {
    const normalized = adapter.normalizeEvent(event);
    return normalized.runtimeEvents;
  });
}

function hasType(events, type) {
  return events.some((event) => event.type === type);
}

const basicEvents = flatten("basic-text.jsonl");
if (!hasType(basicEvents, "assistant.text") || !hasType(basicEvents, "turn.result")) {
  throw new Error(`basic-text must expose assistant.text and turn.result, got ${basicEvents.map((e) => e.type).join(",")}`);
}

const toolEvents = flatten("tool-use.jsonl");
for (const type of ["tool.started", "tool.input.delta", "tool.input.done", "tool.done"]) {
  if (!hasType(toolEvents, type)) {
    throw new Error(`tool-use must expose ${type}, got ${toolEvents.map((e) => e.type).join(",")}`);
  }
}

const permissionEvents = flatten("control-permission.jsonl");
if (!hasType(permissionEvents, "permission.requested")) {
  throw new Error("permission control request must expose permission.requested");
}

const taskEvents = flatten("task-progress.jsonl");
if (!hasType(taskEvents, "turn.progress")) {
  throw new Error("task telemetry must expose turn.progress");
}

const unknownEvents = flatten("unknown-runtime.jsonl");
if (!hasType(unknownEvents, "runtime.warning")) {
  throw new Error("unknown vendor events must degrade to runtime.warning");
}

const pythonGameEvents = flatten("python-game-probe.jsonl");
for (const type of ["turn.progress", "tool.started", "tool.done", "assistant.text", "turn.result"]) {
  if (!hasType(pythonGameEvents, type)) {
    throw new Error(`python-game probe must expose ${type}, got ${pythonGameEvents.map((e) => e.type).join(",")}`);
  }
}
if (pythonGameEvents.some((event) => event.type === "runtime.warning")) {
  throw new Error("python-game probe must not produce runtime.warning for known Claude CLI events");
}

const adapter = new ClaudeCliAdapter();
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
if (!hasType(status.runtimeEvents, "turn.progress") || status.warnings.length !== 0) {
  throw new Error(`system/status must expose progress without warning, got ${JSON.stringify(status)}`);
}
if (!status.backgroundActivity || status.backgroundActivity.short) {
  throw new Error(`system/status must keep runtime active, got ${JSON.stringify(status.backgroundActivity)}`);
}

const completed = adapter.normalizeEvent({
  type: "system",
  subtype: "task_completed",
  message: "Done",
});
if (!completed.backgroundActivity?.short) {
  throw new Error(`task_completed must shorten background activity, got ${JSON.stringify(completed.backgroundActivity)}`);
}

console.log("runtime-adapter: ok");
