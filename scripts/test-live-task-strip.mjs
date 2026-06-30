#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildLiveTaskStripModel } from "../src/renderer/modules/live-task-strip.js";

const translate = (key, params = {}) => {
  const table = {
    "todo.summary": `Tasks ${params.done}/${params.total}`,
    "task.strip.current": `Now ${params.item}`,
    "task.strip.running": "Working",
    "task.strip.toolRunning": "Tool running",
    "task.strip.noVisibleProgress": "Still working",
    "task.strip.awaitingUser": "Waiting",
    "task.strip.stalled": "Needs recovery",
    "task.strip.failed": "Failed",
    "task.strip.status": `Task ${params.status}`,
    "task.strip.statusDetail": `Task ${params.status} ${params.detail}`,
    "task.strip.step": `Step ${params.item}`,
    "task.strip.risk": `Watch ${params.code}`,
    "task.strip.evidence": `${params.count} evidence`,
  };
  return table[key] || key;
};

assert.equal(buildLiveTaskStripModel(null, translate).visible, false);
assert.equal(buildLiveTaskStripModel({ final: { type: "turn.completed" } }, translate).visible, false);

const taskOnly = buildLiveTaskStripModel({
  taskRun: {
    status: "running",
    phase: "tool_running",
    activeStep: "execute",
    plan: [{ id: "execute", title: "Run the command", status: "in_progress" }],
    liveness: { status: "no_visible_progress", detail: "python report.py is still running" },
    risks: [{ code: "NO_VISIBLE_PROGRESS", level: "info" }],
    evidence: [{ kind: "tool_result" }, { kind: "tool_result" }],
  },
}, translate);
assert.equal(taskOnly.visible, true);
assert.equal(taskOnly.summary, "Task Still working python report.py is still running");
assert(taskOnly.items.some((item) => item.content === "Step Run the command"));
assert(taskOnly.items.some((item) => item.content === "Watch NO_VISIBLE_PROGRESS"));
assert(taskOnly.items.some((item) => item.content === "2 evidence"));

const withTodos = buildLiveTaskStripModel({
  tools: new Map([[
    "todo_1",
    {
      name: "todowrite",
      input: {
        todos: [
          { content: "Read files", status: "completed" },
          { content: "Patch UI", status: "in_progress" },
        ],
      },
    },
  ]]),
  taskRun: { status: "running", liveness: { status: "tool_running" } },
}, translate);
assert.equal(withTodos.visible, true);
assert.equal(withTodos.summary, "Tasks 1/2 · Now Patch UI");
assert.equal(withTodos.items.length, 2);

console.log("live-task-strip: ok");
