#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  prepareProcessRenderView,
  processStructureSignature,
} from "../src/renderer/modules/turn-process-render-view.js";
import {
  prepareProcessRenderView as compatPrepareProcessRenderView,
  processStructureSignature as compatProcessStructureSignature,
} from "../src/renderer/modules/turn-process-layout.js";

const processView = prepareProcessRenderView({
  timeline: [
    { kind: "thinking", id: "think_1", text: "done", status: "done" },
    { kind: "thinking", id: "think_2", text: "second", status: "done" },
    { kind: "tool", id: "todo_1", name: "TodoWrite" },
    { kind: "tool", id: "task_1", name: "Task", status: "running", metadata: { sessionId: "sub_1" } },
    { kind: "tool", id: "parent_1", name: "Bash" },
    { kind: "tool", id: "child_1", name: "Read", parentToolUseId: "parent_1" },
    { kind: "notice", id: "notice_1", detail: "notice" },
    { kind: "text", id: "text_1", text: "progress" },
  ],
  subagents: new Map([["sub_1", { sessionId: "sub_1", status: "running" }]]),
}, true, {
  diffEntries: [{ filePath: "/tmp/a.js" }],
  sessionId: "session_1",
});

assert.equal(processView.hasContent, true);
assert.equal(processView.latestTodoId, "todo_1");
assert.equal(processView.childToolIds.has("child_1"), true);
assert.deepEqual(processView.processTools.map((entry) => entry.id), ["parent_1"]);
assert.equal(processView.collapsed, true);
assert.equal(processView.groupThinking, true);
assert.equal(processView.subagents.length, 1);
assert.equal(processView.entryCtx.latestTodoId, "todo_1");
assert.equal(processView.entryCtx.sessionId, "session_1");
assert.equal(processView.diffKey, "1");
assert.equal(processView.hasDiffs, true);
assert.deepEqual(
  compatPrepareProcessRenderView({ timeline: [{ kind: "tool", id: "todo", name: "TodoWrite" }] }, true).latestTodoId,
  "todo",
);

const sigBaseTurn = {
  timeline: [
    { kind: "thinking", id: "think_1", text: "plan", status: "done" },
    { kind: "tool", id: "task_1", name: "Task", status: "running", metadata: { sessionId: "sub_1" } },
  ],
  subagents: new Map([
    ["sub_1", {
      sessionId: "sub_1",
      textFull: "abc",
      pendingPermissions: [],
      pendingQuestions: [],
      phase: "running",
      phaseDetail: "reading",
      stats: { totalTools: 1, runningTools: 1 },
    }],
  ]),
};
const sigA = processStructureSignature(sigBaseTurn, true, { diffCount: 0 });
const sigB = processStructureSignature({
  ...sigBaseTurn,
  subagents: new Map([
    ["sub_1", {
      ...sigBaseTurn.subagents.get("sub_1"),
      textFull: "abcd",
      pendingQuestions: [{}],
    }],
  ]),
}, true, { diffCount: 0 });
assert.notEqual(sigA, sigB);
assert.match(sigA, /subagents:/);
assert.notEqual(processStructureSignature(sigBaseTurn, true, { diffCount: 1 }), sigA);
assert.equal(compatProcessStructureSignature(sigBaseTurn, true, { diffCount: 0 }), sigA);

const rendererSource = readFileSync(
  new URL("../src/renderer/modules/turn-process-renderer.js", import.meta.url),
  "utf8",
);
assert.match(rendererSource, /from "\.\/turn-process-render-view\.js"/);

const layoutSource = readFileSync(
  new URL("../src/renderer/modules/turn-process-layout.js", import.meta.url),
  "utf8",
);
assert.match(layoutSource, /from "\.\/turn-process-render-view\.js"/);
assert.doesNotMatch(layoutSource, /function prepareProcessRenderView\s*\(/);
assert.doesNotMatch(layoutSource, /function processStructureSignature\s*\(/);

console.log("turn-process-render-view: ok");
