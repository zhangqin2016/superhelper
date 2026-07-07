#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildChildToolsMap,
  collectSubagentEntries,
  isSubagentEntry,
  shouldAppendCollapsedProcessGroupFallback,
  shouldRenderEntryInCollapsedProcess,
  shouldRenderThinkingStackForEntry,
  shouldSkipProcessTimelineEntry,
} from "../src/renderer/modules/turn-process-view-model.js";
import {
  buildChildToolsMap as compatBuildChildToolsMap,
  collectSubagentEntries as compatCollectSubagentEntries,
} from "../src/renderer/modules/turn-process-layout.js";

const childTools = buildChildToolsMap([
  { kind: "tool", id: "parent", name: "Task" },
  { kind: "tool", id: "child", name: "Read", parentToolUseId: "parent" },
  { kind: "tool", id: "missingChild", name: "Read", parentToolUseId: "missing" },
  { kind: "tool", id: "self", name: "Read", parentToolUseId: "self" },
]);
assert.deepEqual(childTools.get("parent").map((entry) => entry.id), ["child"]);
assert.equal(childTools.has("missing"), false);
assert.equal(childTools.has("self"), false);
assert.deepEqual(
  compatBuildChildToolsMap([{ kind: "tool", id: "p" }, { kind: "tool", id: "c", parentToolUseId: "p" }]).get("p").map((entry) => entry.id),
  ["c"],
);

const subagentStore = new Map([
  ["sub_1", { sessionId: "sub_1", description: "Existing task", label: "reviewer", status: "running" }],
  ["orphan", { sessionId: "orphan", description: "Store only", label: "worker", status: "done", parentToolId: "parent_tool" }],
]);
const subagentEntries = collectSubagentEntries([
  { kind: "tool", id: "task_1", name: "Task", status: "running", metadata: { sessionId: "sub_1" }, input: { description: "from tool" } },
], { subagents: subagentStore });
assert.equal(subagentEntries.length, 2);
assert.equal(subagentEntries[0].subagent.sessionId, "sub_1");
assert.equal(subagentEntries[1].id, "parent_tool");
assert.equal(subagentEntries[1].input.subagent_type, "worker");
assert.equal(compatCollectSubagentEntries([], { subagents: subagentStore }).length, 2);

assert.equal(isSubagentEntry({ name: "Task" }), true);
assert.equal(isSubagentEntry({ name: "Read" }), false);
assert.equal(shouldSkipProcessTimelineEntry({ kind: "tool", id: "child", name: "Read" }, { childToolIds: new Set(["child"]) }), true);
assert.equal(shouldSkipProcessTimelineEntry({ kind: "tool", id: "task_2", name: "Task" }), true);
assert.equal(shouldSkipProcessTimelineEntry({ kind: "tool", id: "bash_1", name: "Bash" }), false);

assert.equal(shouldRenderEntryInCollapsedProcess({ kind: "thinking" }), true);
assert.equal(shouldRenderEntryInCollapsedProcess({ kind: "text" }), true);
assert.equal(shouldRenderEntryInCollapsedProcess({ kind: "tool", name: "TodoWrite" }), true);
assert.equal(shouldRenderEntryInCollapsedProcess({ kind: "tool", name: "Bash" }), false);
assert.equal(shouldRenderThinkingStackForEntry({ kind: "thinking" }, { groupThinking: true }), true);
assert.equal(shouldRenderThinkingStackForEntry({ kind: "thinking" }, { groupThinking: false }), false);
assert.equal(shouldRenderThinkingStackForEntry({ kind: "text" }, { groupThinking: true }), false);
assert.equal(shouldAppendCollapsedProcessGroupFallback({ groupInserted: false, processTools: [{}], notices: [] }), true);
assert.equal(shouldAppendCollapsedProcessGroupFallback({ groupInserted: false, processTools: [], notices: [{}] }), true);
assert.equal(shouldAppendCollapsedProcessGroupFallback({ groupInserted: true, processTools: [{}], notices: [{}] }), false);
assert.equal(shouldAppendCollapsedProcessGroupFallback({ groupInserted: false, processTools: [], notices: [] }), false);

for (const file of [
  "turn-process-layout.js",
  "turn-process-timeline.js",
]) {
  const source = readFileSync(
    new URL(`../src/renderer/modules/${file}`, import.meta.url),
    "utf8",
  );
  assert.match(source, /from "\.\/turn-process-view-model\.js"/, `${file} should import process view helpers from turn-process-view-model`);
}

const layoutSource = readFileSync(
  new URL("../src/renderer/modules/turn-process-layout.js", import.meta.url),
  "utf8",
);
assert.doesNotMatch(layoutSource, /function buildChildToolsMap\s*\(/);
assert.doesNotMatch(layoutSource, /function collectSubagentEntries\s*\(/);

console.log("turn-process-view-model: ok");
