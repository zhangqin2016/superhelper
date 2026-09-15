#!/usr/bin/env node
// Continuation prompts carry the concrete work state (files written/edited,
// commands run, the model's todo list with statuses, the tail of the last
// answer) instead of tool COUNTS only — captured with the source, persisted in
// the recovery row (so the restart lane has it), rendered into the
// parent-closure prompt, and handed to the manual "继续" follow-up context.
// [gate: task-completion-integrity]
// Run: node scripts/test-parent-closure-work-state.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { summarizeWorkState, renderWorkState, hasWorkState } = require("../src/main/turn-work-state.js");
const { captureParentClosureSource } = require("../src/main/turn-parent-closure-runtime.js");
const { buildParentClosurePrompt } = require("../src/main/parent-task-closure.js");
const { buildShortFollowupContext } = require("../src/main/session-followup-context.js");
const { MessageStore } = require("../src/main/store/message-store.js");
const methods = require("../src/main/session-parent-closure-recovery.js");
const { createTurnRecoveryRuntime } = require("../src/main/turn-recovery-runtime.js");

let checks = 0;
async function check(name, fn) { await fn(); checks += 1; console.log(`ok - ${name}`); }

const tools = new Map([
  ["t1", { id: "t1", name: "read", status: "done", input: { filePath: "src/a.js" } }],
  ["t2", { id: "t2", name: "write", status: "done", input: { filePath: "dist/export.sh", content: "..." } }],
  ["t3", { id: "t3", name: "edit", status: "done", input: { filePath: "src/a.js", oldString: "x", newString: "y" } }],
  ["t4", { id: "t4", name: "bash", status: "done", input: { command: "docker save harbor/safar-agent:4789146e -o dist/agent.tar", description: "export" } }],
  ["t5", { id: "t5", name: "bash", status: "failed", input: { command: "docker load -i dist/agent.tar" } }],
  ["t6", { id: "t6", name: "todowrite", status: "done", input: { todos: [{ content: "导出 agent", status: "completed" }, { content: "导出 rag", status: "in_progress" }, { content: "校验", status: "pending" }] } }],
]);
const state = { turnId: "src", tools, enginePayload: { rawText: "导出三个镜像并校验" }, assistantText: "已导出 agent，正在导出 rag……", pendingPermissions: new Map(), pendingQuestions: new Map(), pendingHooks: new Map() };

await check("work state names files, commands (with unconfirmed results), the todo list and the last output; reads are not 'work'", async () => {
  const ws = summarizeWorkState(state);
  assert.deepEqual(ws.files, [{ path: "dist/export.sh", action: "write", ok: true }, { path: "src/a.js", action: "edit", ok: true }]);
  assert.equal(ws.commands.length, 2);
  assert.equal(ws.commands[1].ok, false);
  assert.deepEqual(ws.todos.map((t) => t.status), ["completed", "in_progress", "pending"]);
  assert.match(ws.lastAssistantText, /正在导出 rag/);
  const plan = summarizeWorkState({ ...state, taskRun: { plan: [{ title: "P1", status: "completed" }, { title: "P2", status: "pending" }] } });
  assert.deepEqual(plan.todos.map((t) => t.content), ["P1", "P2"], "the reconciled task plan wins over the raw todowrite");
  assert.equal(hasWorkState(summarizeWorkState({ tools: new Map() })), false);
  assert.deepEqual(renderWorkState(null), []);
  const bounded = summarizeWorkState({ tools: new Map(Array.from({ length: 40 }, (_, i) => [`w${i}`, { name: "write", status: "done", input: { filePath: `f${i}.txt` } }])), assistantText: "z".repeat(5000) });
  assert.equal(bounded.files.length, 12);
  assert.ok(bounded.lastAssistantText.length <= 600);
});

await check("the parent-closure prompt renders the work state instead of counts only", async () => {
  const source = captureParentClosureSource(state, { stalled: true });
  assert.ok(hasWorkState(source.workState));
  const prompt = buildParentClosurePrompt({ objective: source.objective, evidence: { done: [1, 2, 3, 4], failed: [1], running: [] }, workState: source.workState });
  assert.match(prompt, /已改动文件：\n- dist\/export\.sh（写入）\n- src\/a\.js（编辑）/);
  assert.match(prompt, /已执行命令：/);
  assert.match(prompt, /docker load -i dist\/agent\.tar（结果未确认）/);
  assert.match(prompt, /\[x\] 导出 agent\n\[~\] 导出 rag\n\[ \] 校验/);
  assert.match(prompt, /上一轮最后的输出：已导出 agent/);
  assert.match(prompt, /不要重做已完成的部分/);
  const bare = buildParentClosurePrompt({ objective: "x", evidence: { done: [], failed: [], running: [] } });
  assert.doesNotMatch(bare, /工作状态/);
});

await check("the work state is persisted with the recovery row and reaches the restart lane's prompt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "closure-work-state-"));
  const store = new MessageStore(path.join(root, "messages.db"), path.join(root, "blobs"));
  const ownerScope = "account:ws";
  let now = Date.now();
  store.admitTurnInput("s", { turnId: "src", delivery: "direct", status: "completed", userText: "导出三个镜像并校验", files: [], metadata: {}, createdAt: now }, { ownerScope });
  const manager = Object.assign({ _find: () => ({ id: "s" }), resolveTurnOwnerScope: () => ({ ok: true, ownerScope }), _ensureImported() {}, _store: () => store,
    getTurnInputByTurnId: (_s, id) => store.getTurnInputByTurnId(id, ownerScope) }, methods);
  const sends = [];
  const runtime = createTurnRecoveryRuntime({ ctx: { sessionManager: manager }, now: () => now, setTimeout: () => ({ unref() {} }), clearTimeout() {},
    sendUserMessage: async (_s, text, files, opts) => {
      sends.push(opts);
      store.admitTurnInput("s", { turnId: opts.turnId, delivery: "direct", status: "admitted", userText: text, files, metadata: {}, createdAt: now }, { ownerScope });
      return { ok: true, turnId: opts.turnId };
    } });
  try {
    const source = captureParentClosureSource({ ...state, taskContract: { active: true, taskType: "code_change", categories: [] } }, { stalled: true });
    source.taskContract = { active: true, taskType: "code_change", categories: [] };
    const prepared = runtime.prepareParentClosureRecovery("s", source);
    assert.equal(prepared.prepared, true);
    const row = manager.getParentClosureRecovery("s", "src");
    assert.deepEqual(row.source.workState.files.map((f) => f.path), ["dist/export.sh", "src/a.js"], "persisted with the row");
    assert.equal(runtime.recoverySourceForTurn("s", "src").workState.todos.length, 3);
    // Restart lane: a fresh runtime rebuilds the prompt from the persisted row only.
    const restarted = createTurnRecoveryRuntime({ ctx: { sessionManager: manager }, now: () => now, setTimeout: () => ({ unref() {} }), clearTimeout() {},
      sendUserMessage: runtime === null ? null : async (_s, text, files, opts) => { sends.push(opts); store.admitTurnInput("s", { turnId: opts.turnId, delivery: "direct", status: "admitted", userText: text, files, metadata: {}, createdAt: now }, { ownerScope }); return { ok: true, turnId: opts.turnId }; } });
    const resumed = await restarted.resumePendingParentClosures("s");
    assert.equal(resumed, 1);
    assert.equal(sends.length, 1);
    assert.match(sends[0].recovery.guidance, /已改动文件：\n- dist\/export\.sh（写入）/);
    assert.match(sends[0].recovery.guidance, /\[~\] 导出 rag/);
  } finally {
    store.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

await check("the manual 继续 after a cut-off turn carries the unfinished items and the work state; a finished turn does not", async () => {
  const recovery = { continuationHandoff: { unfinished: [{ title: "校验 tar 可 docker load" }] }, workState: summarizeWorkState(state) };
  const messages = [
    { role: "user", content: "导出三个镜像并校验", turnId: "src" },
    { role: "assistant", content: "已导出 agent……", turnId: "src", record: { terminal: "turn.stalled" } },
  ];
  const text = buildShortFollowupContext({ userText: "继续", messages, recovery });
  assert.match(text, /did NOT finish/);
  assert.match(text, /Unfinished items recorded when the previous turn stopped:\n- 校验 tar 可 docker load/);
  assert.match(text, /已改动文件：/);
  assert.match(text, /\[~\] 导出 rag/);
  const done = buildShortFollowupContext({ userText: "继续", messages: [messages[0], { ...messages[1], record: { terminal: "turn.completed" } }], recovery });
  assert.doesNotMatch(done, /已改动文件/);
  const orchestrator = fs.readFileSync(new URL("../src/main/turn-orchestrator.js", import.meta.url), "utf8");
  // Platform records (continuation stopped, agent bound) carry a synthetic turn
  // id, so `.at(-1)` used to resolve the card instead of the work it describes.
  assert.ok(orchestrator.includes("recoverySourceForTurn?.(session.id, lastRealTurnId(historySession.messages))"),
    "a 继续 must resume the previous REAL turn");
});

console.log(`\n${checks} checks passed (parent closure work state)`);
