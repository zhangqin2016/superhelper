#!/usr/bin/env node
/**
 * Todo-progress nudge plugin (plan-discipline layer). Drives the real
 * tool.execute.after hook. WHY: the nudge must fire only after the list has gone
 * quiet for N tool calls, name the steps the record already supports, restart
 * on every todowrite, stay silent when the plan is finished, never feed its own
 * note back into inference, keep sessions independent, and fail open.
 */
import assert from "node:assert/strict";
import { TodoProgressNudgePlugin } from "../resources/opencode-plugins/todo-progress-nudge.js";

for (const k of ["LILY_TODO_NUDGE", "LILY_TODO_NUDGE_AFTER"]) delete process.env[k];
process.env.LILY_LOCALE = "zh-CN";

const hooks = await TodoProgressNudgePlugin();
const after = hooks["tool.execute.after"];
assert.equal(typeof after, "function");

async function run(sessionID, tool, args, outText = "ok", callID = "") {
  const output = { output: outText };
  await after({ sessionID, tool, args, callID }, output);
  return output.output;
}
const nudged = (s) => /\[plan\]/.test(s);
const todos = (statuses) => ({
  todos: ["创建 0905 目录", "拉取 safar-web:fe2cd212 并保存 tar", "验证所有 tar 文件"].map((content, i) => ({ content, status: statuses[i] || "pending", priority: "medium" })),
});

// 1) No list yet → never nudges, however many tools run.
for (let i = 0; i < 6; i++) assert.equal(nudged(await run("s0", "bash", { command: "ls" })), false);

// 2) With a stale list: silent for N-1 calls, nudge on the Nth, naming evidenced steps.
assert.equal(nudged(await run("s1", "todowrite", todos(["in_progress"]))), false, "todowrite itself is never annotated");
assert.equal(nudged(await run("s1", "bash", { command: "mkdir -p /d/0905" })), false);
assert.equal(nudged(await run("s1", "bash", { command: "docker pull h/safar-web:fe2cd212" })), false);
assert.equal(nudged(await run("s1", "bash", { command: "docker save h/safar-web:fe2cd212 -o w.tar" })), false);
const note = await run("s1", "bash", { command: "ls -lh /d/0905" });
assert.equal(nudged(note), true, "4th tool since todowrite → nudge");
assert.match(note, /已 4 步未更新/);
assert.match(note, /第 1、2 项/, "steps 1 and 2 are evidenced by their unique identifiers; step 3 is generic");
assert.match(note, /只更新状态/);

// 3) Repeat cadence: silent for the next N-1, nudge again at 2N.
for (let i = 0; i < 3; i++) assert.equal(nudged(await run("s1", "bash", { command: `echo ${i}` })), false);
assert.equal(nudged(await run("s1", "bash", { command: "echo 3" })), true);

// 4) A todowrite resets the clock; a finished plan never nudges.
assert.equal(nudged(await run("s1", "todowrite", todos(["completed", "completed", "in_progress"]))), false);
for (let i = 0; i < 3; i++) assert.equal(nudged(await run("s1", "bash", { command: `sha256sum ${i}.tar` })), false);
await run("s1", "todowrite", todos(["completed", "completed", "completed"]));
for (let i = 0; i < 6; i++) assert.equal(nudged(await run("s1", "bash", { command: `echo done ${i}` })), false, "all completed → silent");

// 5) Sessions are independent.
await run("a", "todowrite", todos(["pending"]));
for (let i = 0; i < 4; i++) await run("b", "bash", { command: "echo b" });
assert.equal(nudged(await run("a", "bash", { command: "echo a" })), false, "session b's traffic does not age session a's list");

// 6) A failed tool result is not evidence for the named steps.
await run("f", "todowrite", todos(["pending"]));
for (let i = 0; i < 3; i++) await run("f", "bash", { command: "echo warmup" });
const failNote = await run("f", "bash", { command: "docker pull h/safar-web:fe2cd212" }, "Error: manifest unknown");
assert.equal(nudged(failNote), true);
assert.doesNotMatch(failNote, /第 [12]/, "a failed pull is not 'looks done'");

// 7) Our own note never feeds the next inference (signature taken from raw result).
await run("n", "todowrite", todos(["pending"]));
for (let i = 0; i < 3; i++) await run("n", "bash", { command: "echo x" });
const first = await run("n", "bash", { command: "echo y" });
assert.equal(nudged(first), true);
assert.equal((first.match(/\[plan\]/g) || []).length, 1, "exactly one note appended");

// 8) Content-array outputs get a text part; env kill switch; fail-open on garbage.
const arr = { content: [{ type: "text", text: "r" }] };
await run("c", "todowrite", todos(["pending"]));
for (let i = 0; i < 3; i++) await run("c", "bash", { command: "echo c" });
await after({ sessionID: "c", tool: "bash", args: { command: "echo c4" } }, arr);
assert.equal(arr.content.length, 2);
assert.match(arr.content[1].text, /\[plan\]/);
process.env.LILY_TODO_NUDGE = "0";
await run("k", "todowrite", todos(["pending"]));
for (let i = 0; i < 5; i++) assert.equal(nudged(await run("k", "bash", { command: "echo k" })), false, "kill switch");
delete process.env.LILY_TODO_NUDGE;
await after(null, null);
await after({ sessionID: "g", tool: "todowrite", args: { todos: "nope" } }, { output: "x" });
await after({ sessionID: "g", tool: "bash", args: undefined }, 42);

console.log("test-todo-progress-nudge-plugin: ok");
