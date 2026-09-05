#!/usr/bin/env node
/**
 * Todo-progress inference library (shared by the OpenCode nudge plugin and the
 * main-process overlay). WHY each assertion matters: the overlay may only claim
 * what the execution record literally supports — a false "done" is worse than
 * the stale card it replaces. So: identifiers unique to a step are evidence,
 * shared or generic words are not; a failed final attempt proves nothing; a
 * running match reads as "active"; garbage input never throws.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lib = require("../resources/opencode-plugins/lib/todo-progress.cjs");

// 1) Token extraction: identifiers in, generic words out.
assert.deepEqual(lib.extractStepTokens("拉取 safar-rag:a1892790 并保存 tar"), ["safar-rag:a1892790"]);
assert.deepEqual(lib.extractStepTokens("创建 0905 目录"), ["0905"]);
assert.deepEqual(lib.extractStepTokens("验证所有 tar 文件"), [], "generic step has no identifier");
assert.deepEqual(lib.extractStepTokens("Build the docker image and install packages"), [], "stop-words are not identifiers");
assert.ok(lib.extractStepTokens('Rename "报告草稿" to final').includes("报告草稿"), "quoted names count even in CJK");
assert.ok(lib.extractStepTokens("Patch src/main/model-presets.js").includes("src/main/model-presets.js"));

// 2) Uniqueness: a token shared by several steps proves none of them.
const sets = lib.computeStepTokenSets(["pull safar-web:fe2cd212", "pull safar-rag:a1892790", "verify safar-web:fe2cd212 checksum"]);
assert.deepEqual(sets[1].unique, ["safar-rag:a1892790"]);
assert.deepEqual(sets[0].unique, [], "safar-web:fe2cd212 appears in two steps → shared, not unique");
assert.deepEqual(sets[0].shared, ["safar-web:fe2cd212"]);

// 3) The field case: one todowrite, then tools — steps 1-3 evidenced, 4 not run, 5 running, 7 generic.
const steps = [
  "创建 0905 目录", "拉取 safar-server:debug-0dfd878b 并保存 tar", "拉取 safar-web:fe2cd212 并保存 tar",
  "拉取 safar-rag:a1892790 并保存 tar", "拉取 safar-ai:34e98401 并保存 tar", "拉取 safar-agent:aacb1b66 并保存 tar", "验证所有 tar 文件",
].map((title, i) => ({ title, status: i === 0 ? "in_progress" : "pending" }));
const tools = [
  { id: "c1", name: "bash", input: { command: "mkdir -p /x/deploytoa/0905 && ls -la /x/deploytoa/0905/" }, status: "done" },
  { id: "c2", name: "bash", input: { command: "docker pull harbor/mss/safar-server:debug-0dfd878b | tail -20" }, status: "done" },
  { id: "c3", name: "bash", input: { command: "docker save harbor/mss/safar-server:debug-0dfd878b -o s.tar" }, status: "done" },
  { id: "c4", name: "bash", input: { command: "docker pull harbor/mss/safar-web:fe2cd212" }, status: "done" },
  { id: "c5", name: "bash", input: { command: "docker pull harbor/mss/safar-ai:34e98401" }, status: "running" },
];
const inf = lib.inferPlanProgress(steps, tools);
assert.deepEqual(inf.map((r) => r.inferred), ["evidenced", "evidenced", "evidenced", null, "active", null, null]);
assert.equal(inf[1].toolId, "c3", "latest matching call wins (save after pull)");
assert.match(inf[1].snippet, /safar-server:debug-0dfd878b/);

// 4) A failed final attempt is not evidence, and older successes are superseded.
const failed = lib.inferPlanProgress([{ title: "pull safar-web:fe2cd212", status: "pending" }], [
  { id: "a", name: "bash", input: { command: "docker pull x/safar-web:fe2cd212" }, status: "done" },
  { id: "b", name: "bash", input: { command: "docker pull x/safar-web:fe2cd212" }, status: "failed" },
]);
assert.equal(failed[0].inferred, null);

// 5) Model-confirmed steps are never re-judged; output-only mentions are not evidence.
const outputOnly = lib.inferPlanProgress(
  [{ title: "delete release-2026-09.zip", status: "pending" }, { title: "done step-2026-08", status: "completed" }],
  [{ id: "l", name: "bash", input: { command: "ls" }, result: "release-2026-09.zip step-2026-08", status: "done" }],
);
assert.deepEqual(outputOnly.map((r) => r.inferred), [null, null]);

// 6) Nudge note: names evidenced steps, asks for a status-only update, in each locale.
const zh = lib.buildNudgeNote({ locale: "zh-CN", sinceCount: 5, steps, inference: inf });
assert.match(zh, /^\[plan\] 任务清单已 5 步未更新（已确认 0\/7）/);
assert.match(zh, /第 1、2、3 项/);
assert.match(zh, /todowrite/);
const en = lib.buildNudgeNote({ locale: "en-US", sinceCount: 4, steps, inference: inf });
assert.match(en, /steps 1, 2, 3/);
const ar = lib.buildNudgeNote({ locale: "ar", sinceCount: 4, steps, inference: inf });
assert.match(ar, /^\[plan\] /);
assert.match(ar, /todowrite/);
const bare = lib.buildNudgeNote({ locale: "en", sinceCount: 4, steps, inference: inf.map((r) => ({ ...r, inferred: null })) });
assert.doesNotMatch(bare, /Per the execution record/, "no evidence → no false hint");

// 7) Fail-safe on garbage.
assert.deepEqual(lib.inferPlanProgress(null, null), []);
assert.deepEqual(lib.inferPlanProgress([{ title: null }], [{}, null, 42]).map((r) => r.inferred), [null]);
assert.equal(lib.resultText({ content: [{ type: "text", text: "a" }, { type: "image" }] }), "a");
assert.equal(typeof lib.buildNudgeNote({}), "string");

console.log("test-todo-progress-inference: ok");
