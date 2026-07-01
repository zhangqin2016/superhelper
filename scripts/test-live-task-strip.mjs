#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildLiveTaskStripModel } from "../src/renderer/modules/live-task-strip.js";

const translate = (key, params = {}) => {
  const table = {
    "todo.summary": `Tasks ${params.done}/${params.total}`,
    "task.strip.current": `Now ${params.item}`,
  };
  return table[key] || key;
};

assert.equal(buildLiveTaskStripModel(null, translate).visible, false);
assert.equal(buildLiveTaskStripModel({ final: { type: "turn.completed" } }, translate).visible, false);
assert.equal(
  buildLiveTaskStripModel({
    taskRun: {
      status: "running",
      phase: "starting",
      activeStep: "execute",
      plan: [
        { id: "understand", title: "Understand request", status: "completed" },
        { id: "execute", title: "Execute with available tools", status: "in_progress" },
        { id: "verify", title: "Verify or report evidence", status: "pending" },
      ],
      liveness: { status: "starting" },
    },
  }, translate).visible,
  false,
);

const taskOnly = buildLiveTaskStripModel({
  taskRun: {
    status: "running",
    phase: "tool_running",
    activeStep: "execute",
    plan: [{ id: "execute", title: "Run the command", status: "in_progress" }],
    liveness: { status: "no_visible_progress", detail: "python report.py is still running" },
    risks: [{ code: "NO_VISIBLE_PROGRESS", level: "info" }],
    evidence: [{ kind: "tool_result" }, { kind: "tool_result" }],
    resumeState: { replaySafe: false },
  },
}, translate);
assert.equal(taskOnly.visible, false);

const genericStep = buildLiveTaskStripModel({
  taskRun: {
    status: "running",
    phase: "tool_running",
    activeStep: "execute",
    plan: [{ id: "execute", title: "Execute with available tools", status: "in_progress" }],
    liveness: { status: "tool_running", detail: "网页扫描队列：种子 1 · JS 路由 0" },
  },
}, translate);
assert.equal(genericStep.visible, false);

const writeOnly = buildLiveTaskStripModel({
  tools: new Map([[
    "tool_write",
    {
      id: "tool_write",
      name: "Write",
      status: "running",
      input: { file_path: "cult-lamb.html", content: "<html></html>" },
    },
  ]]),
}, translate);
assert.equal(writeOnly.visible, false);

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

const activeFromTaskRun = buildLiveTaskStripModel({
  tools: new Map([[
    "todo_1",
    {
      name: "todowrite",
      input: {
        todos: [
          { content: "Build canvas", status: "pending" },
          { content: "Add pets", status: "pending" },
        ],
      },
    },
  ]]),
  taskRun: {
    activeStep: "todo_1",
    plan: [
      { id: "todo_1", title: "Build canvas", status: "pending" },
      { id: "todo_2", title: "Add pets", status: "pending" },
    ],
  },
}, translate);
assert.equal(activeFromTaskRun.visible, true);
assert.equal(activeFromTaskRun.summary, "Tasks 0/2 · Now Build canvas");
assert.equal(activeFromTaskRun.items[0].status, "in_progress");
assert.equal(activeFromTaskRun.items[1].status, "pending");

console.log("live-task-strip: ok");
