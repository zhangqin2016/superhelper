#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  hasRunningTool,
  resolveActivityLabel,
  resolveRunningToolLabel,
  upsertTimelineTool,
} from "../src/renderer/modules/turn-tool-timeline.js";
import {
  applyProcessEventToTimeline,
  upsertTimelineTool as compatUpsertTimelineTool,
} from "../src/renderer/modules/turn-timeline.js";

const turn = { timeline: [], activityLabel: "Reading recent chapters" };
upsertTimelineTool(turn, {
  id: "read_1",
  name: "Read",
  input: { file_path: "src/a.js" },
  status: "running",
}, 10);
assert.equal(turn.timeline.length, 1);
assert.equal(turn.timeline[0].preview, "Read src/a.js");
assert.equal(turn.timeline[0].startTs, 10);
assert.equal(turn.activityLabel, "Read src/a.js");

upsertTimelineTool(turn, {
  id: "read_1",
  status: "done",
  result: { content: "ok" },
}, 20);
assert.equal(turn.timeline[0].startTs, 10);
assert.equal(turn.timeline[0].ts, 20);
assert.deepEqual(turn.timeline[0].result, { content: "ok" });

const todos = { timeline: [] };
upsertTimelineTool(todos, {
  id: "todo_1",
  name: "todowrite",
  status: "completed",
  input: { todos: [{ content: "A", status: "pending" }] },
}, 1);
upsertTimelineTool(todos, {
  id: "todo_2",
  name: "TodoWrite",
  status: "completed",
  input: { todos: [{ content: "A", status: "completed" }] },
}, 2);
assert.equal(todos.timeline.length, 1);
assert.equal(todos.timeline[0].id, "todo_1");
assert.equal(todos.timeline[0].input.todos[0].status, "completed");

assert.equal(hasRunningTool([{ id: "b1", name: "Bash", status: "running", input: { command: "npm test" } }]), true);
assert.equal(resolveRunningToolLabel({
  tools: new Map([["b1", { id: "b1", name: "Bash", status: "running", input: { command: "npm test" } }]]),
}), "Bash npm test");
assert.equal(resolveActivityLabel({
  activityLabel: "Reading",
  tools: [{ id: "b1", name: "Bash", status: "running", input: { command: "npm test" } }],
}), "Bash npm test");
assert.equal(resolveActivityLabel({ activityLabel: "Reading" }), "Reading");

const compatTurn = { timeline: [] };
compatUpsertTimelineTool(compatTurn, { id: "b1", name: "Bash", input: { command: "ls" } }, 30);
assert.equal(compatTurn.timeline[0].preview, "Bash ls");

const activityTurn = {
  timeline: [],
  activityLabel: "Bash npm test",
  tools: [{ id: "b1", name: "Bash", status: "running", input: { command: "npm test" } }],
};
applyProcessEventToTimeline(activityTurn, { rawSubtype: "status", event: { status: "Reading files" } }, 40);
assert.equal(activityTurn.activityLabel, "Bash npm test");

const timelineSource = readFileSync(
  new URL("../src/renderer/modules/turn-timeline.js", import.meta.url),
  "utf8",
);
assert.match(timelineSource, /from "\.\/turn-tool-timeline\.js"/);
assert.doesNotMatch(timelineSource, /function upsertTimelineTool\s*\(/);
assert.doesNotMatch(timelineSource, /function runningToolActivity\s*\(/);

console.log("turn-tool-timeline: ok");
