#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyToolCategory,
  isFileWriteCategory,
  isTodoTool,
  parseTodoEntries,
  toolEntryToRenderTool,
} from "../src/renderer/modules/turn-tool-model.js";
import {
  classifyToolCategory as compatClassifyToolCategory,
  parseTodoEntries as compatParseTodoEntries,
} from "../src/renderer/modules/turn-process-layout.js";

assert.equal(classifyToolCategory("Read"), "read");
assert.equal(classifyToolCategory("Write"), "write");
assert.equal(classifyToolCategory("MultiEdit"), "write");
assert.equal(classifyToolCategory("Glob"), "search");
assert.equal(classifyToolCategory("Bash"), "command");
assert.equal(classifyToolCategory("WebFetch"), "web");
assert.equal(classifyToolCategory("Task"), "agent");
assert.equal(classifyToolCategory("UnknownTool"), "other");
assert.equal(compatClassifyToolCategory("Write"), classifyToolCategory("Write"));

assert.equal(isTodoTool("TodoWrite"), true);
assert.equal(isTodoTool("Write"), false);
const todos = parseTodoEntries({
  name: "TodoWrite",
  input: { todos: [
    { content: "读取配置", status: "completed" },
    { activeForm: "修改代码", status: "running" },
    { content: "跑测试", status: "weird-status" },
    { content: "  ", status: "pending" },
  ] },
});
assert.deepEqual(todos, [
  { content: "读取配置", status: "completed" },
  { content: "修改代码", status: "in_progress" },
  { content: "跑测试", status: "pending" },
]);
assert.deepEqual(compatParseTodoEntries({ partialJson: '{"todos":[{"content":"a"}]}' }), [
  { content: "a", status: "pending" },
]);
assert.deepEqual(parseTodoEntries({ partialJson: '{"todos":[{"con' }), []);

assert.deepEqual(toolEntryToRenderTool({
  id: "tool_1",
  name: "Write",
  input: { file_path: "a.js" },
  partialJson: "{}",
  status: "running",
  result: { ok: true },
  metadata: { sessionId: "sub_1" },
  title: "Writing file",
}), {
  id: "tool_1",
  name: "Write",
  input: { file_path: "a.js" },
  partialJson: "{}",
  status: "running",
  result: { ok: true },
  metadata: { sessionId: "sub_1" },
  title: "Writing file",
});
assert.equal(isFileWriteCategory({ name: "Edit" }), true);
assert.equal(isFileWriteCategory({ name: "Read" }), false);

const layoutSource = readFileSync(
  new URL("../src/renderer/modules/turn-process-layout.js", import.meta.url),
  "utf8",
);
assert.match(layoutSource, /from "\.\/turn-tool-model\.js"/);
assert.doesNotMatch(layoutSource, /const WRITE_TOOLS\s*=/);
assert.doesNotMatch(layoutSource, /function normalizeTodoStatus\s*\(/);

for (const file of [
  "turn-tool-result-block.js",
  "turn-timeline-entry.js",
  "turn-live-process-patch.js",
  "live-task-strip.js",
]) {
  const source = readFileSync(
    new URL(`../src/renderer/modules/${file}`, import.meta.url),
    "utf8",
  );
  assert.match(source, /from "\.\/turn-tool-model\.js"/, `${file} should import tool semantics from turn-tool-model`);
}

console.log("turn-tool-model: ok");
