#!/usr/bin/env node
/**
 * Plan-progress overlay end to end: task-run kernel (observe → infer →
 * reconcile → compact), the model reconciler's verification floor, and the
 * renderer merge/summary. WHY: the overlay must (a) never alter the model's own
 * statuses, (b) be dropped on every fresh todowrite, (c) turn a stale
 * "in progress" into "unconfirmed" at turn end, (d) accept a model verdict only
 * with a quote that is literally in the evidence, and (e) render as its own
 * visual state — never as a model-confirmed check.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-todo-overlay-"));
process.env.LILY_USER_DATA_DIR = tempUserData;
process.on("exit", () => fs.rmSync(tempUserData, { recursive: true, force: true }));
delete process.env.LILY_TODO_MODEL_RECONCILE;

const {
  applyModelPlanReconciliation, applyTaskPlanFromTodos, compactTaskRun, createTaskRun,
  isTodoPlan, observePlanTool, reconcilePlanAtTurnEnd,
} = require("../src/main/task-run-state.js");
const reconciler = require("../src/main/todo-plan-reconciler.js");
const { overlayPlanOnTodos, summarizeTodoProgress, todoDisplayStatus, todoIcon } = await import("../src/renderer/modules/todo-progress-overlay.js");
const { buildLiveTaskStripModel } = await import("../src/renderer/modules/live-task-strip.js");

const todos = [
  { content: "创建 0905 目录", status: "in_progress" },
  { content: "拉取 safar-web:fe2cd212 并保存 tar", status: "pending" },
  { content: "拉取 safar-rag:a1892790 并保存 tar", status: "pending" },
  { content: "验证所有 tar 文件", status: "pending" },
];

// --- kernel -------------------------------------------------------------
const run = createTaskRun({ sessionId: "s", turnId: "t" });
assert.equal(isTodoPlan(run), false, "scaffold plan is not inferred against");
assert.equal(observePlanTool(run, { id: "x", name: "bash", input: { command: "mkdir 0905" }, status: "done" }), false);
applyTaskPlanFromTodos(run, todos);
assert.equal(isTodoPlan(run), true);
assert.equal(run.planSync.toolsSinceTodo, 0, "fresh todowrite restarts the window");
assert.ok(run.planSync.todoAt > 0);

assert.equal(observePlanTool(run, { id: "c1", name: "bash", input: { command: "mkdir -p /d/0905" }, status: "running" }, { running: true }), true);
assert.equal(run.plan[0].inferred, "active");
assert.equal(run.planSync.toolsSinceTodo, 0, "a running tool has not 'happened' yet");
assert.equal(observePlanTool(run, { id: "c1", name: "bash", input: { command: "mkdir -p /d/0905" }, status: "done" }), true);
assert.equal(run.plan[0].inferred, "evidenced");
assert.equal(run.plan[0].status, "in_progress", "the model's own status is untouched");
assert.equal(run.planSync.toolsSinceTodo, 1);
assert.equal(run.planSync.tools.length, 1, "running row replaced by its finished row, not duplicated");
observePlanTool(run, { id: "c2", name: "bash", input: { command: "docker pull h/safar-web:fe2cd212" }, status: "done" });
observePlanTool(run, { id: "c3", name: "bash", input: { command: "docker pull h/safar-rag:a1892790" }, status: "failed" });
assert.equal(run.plan[1].inferred, "evidenced");
assert.equal(run.plan[2].inferred, null, "failed pull proves nothing");
assert.equal(run.plan[3].inferred, null, "generic step is never inferred");
assert.equal(run.planSync.stale, true);
// todowrite calls never count as work nor as evidence.
assert.equal(observePlanTool(run, { id: "tw", name: "todowrite", input: { todos }, status: "done" }), false);
assert.equal(run.planSync.toolsSinceTodo, 3);

const compact = compactTaskRun(run);
assert.equal(compact.plan[0].inferred, "evidenced");
assert.equal(compact.plan[0].evidence.toolId, "c1");
assert.match(compact.plan[0].evidence.snippet, /0905/);
assert.equal(compact.plan[2].inferred, undefined, "no overlay → no field (compact stays small)");
assert.deepEqual(Object.keys(compact.planSync).sort(), ["reconciled", "stale", "todoAt", "toolsSinceTodo"], "the tool window never leaves the main process");

// A fresh todowrite drops every overlay: the model's statement wins.
applyTaskPlanFromTodos(run, todos.map((t, i) => ({ ...t, status: i < 2 ? "completed" : t.status })));
assert.equal(run.plan.every((s) => !s.inferred), true);
assert.equal(run.planSync.toolsSinceTodo, 0);
assert.equal(run.planSync.stale, false);

// --- end-of-turn deterministic reconciliation --------------------------------
const end = createTaskRun({ sessionId: "s2", turnId: "t2" });
applyTaskPlanFromTodos(end, todos);
observePlanTool(end, { id: "e1", name: "bash", input: { command: "docker pull h/safar-web:fe2cd212" }, status: "done" });
assert.equal(reconcilePlanAtTurnEnd(end, "turn.completed"), true);
assert.equal(end.plan[0].inferred, "unconfirmed", "in_progress with no evidence → unconfirmed at turn end");
assert.equal(end.plan[0].status, "in_progress", "model status still untouched");
assert.equal(end.plan[1].inferred, "evidenced", "evidence survives reconciliation");
assert.equal(end.plan[3].inferred, null, "pending generic step stays pending, not unconfirmed");
assert.equal(end.planSync.reconciled.source, "deterministic");
assert.equal(end.planSync.stale, true);
const scaffold = createTaskRun({ sessionId: "s3", turnId: "t3" });
assert.equal(reconcilePlanAtTurnEnd(scaffold), false, "scaffold plan untouched");

// --- model reconciliation: verification floor -----------------------------------
assert.equal(reconciler.shouldReconcileWithModel(scaffold).ok, false);
const fresh = createTaskRun({ sessionId: "s4", turnId: "t4" });
applyTaskPlanFromTodos(fresh, todos);
assert.equal(reconciler.shouldReconcileWithModel(fresh).reason, "list_fresh", "no tools since todowrite → no model call");
assert.equal(reconciler.shouldReconcileWithModel(end).ok, true, "stale + undecided generic step → warranted");
const prompt = reconciler.buildPrompt(end);
assert.match(prompt, /4\. 验证所有 tar 文件 — pending/);
assert.match(prompt, /E1 \[bash\] input: docker pull h\/safar-web:fe2cd212/);
assert.match(prompt, /verbatim quote/);

const connection = { baseUrl: "https://x", apiKey: "k", model: "m", protocol: "openai" };
const withVerdict = (steps) => reconciler.reconcilePlanWithModel({
  taskRun: end,
  resolveConnection: () => ({ connection, reason: "" }),
  post: async () => `\`\`\`json\n${JSON.stringify({ steps })}\n\`\`\``,
});
// Unverifiable quote → ignored; verifiable quote → model_completed overlay; completed-by-model never re-judged.
let result = await withVerdict([{ index: 4, status: "completed", evidence: "sha256sum all archives OK" }]);
assert.equal(result.applied, 0, "quote not in evidence → rejected");
assert.equal(end.plan[3].inferred, null);
observePlanTool(end, { id: "e2", name: "bash", input: { command: "sha256sum /d/0905/*.tar" }, result: "abc  web.tar\nabd  rag.tar", status: "done" });
result = await withVerdict([
  { index: 4, status: "completed", evidence: "sha256sum /d/0905/*.tar" },
  { index: 1, status: "completed", evidence: "sha256sum /d/0905/*.tar" },
  { index: 2, status: "completed", evidence: "docker pull h/safar-web:fe2cd212" },
]);
assert.equal(result.applied, 2, "step 4 and step 1 accepted; step 2 already evidenced (not re-judged)");
assert.equal(end.plan[3].inferred, "model_completed");
assert.equal(end.plan[3].evidence.source, "model");
assert.equal(end.plan[0].inferred, "model_completed", "an unconfirmed step may be settled by a verified model verdict");
assert.equal(end.plan[1].inferred, "evidenced");
assert.equal(end.planSync.reconciled.source, "model");
assert.equal(end.plan[3].status, "pending", "model's own status untouched even after a verified verdict");
// Malformed / empty / no-connection all fail open.
assert.equal((await reconciler.reconcilePlanWithModel({ taskRun: end, resolveConnection: () => ({ connection, reason: "" }), post: async () => "not json" })).reason, "malformed_verdict");
assert.equal((await reconciler.reconcilePlanWithModel({ taskRun: end, resolveConnection: () => ({ connection: null, reason: "api_key_missing" }) })).reason, "api_key_missing");
process.env.LILY_TODO_MODEL_RECONCILE = "0";
assert.equal(reconciler.shouldReconcileWithModel(end).ok, false, "kill switch");
delete process.env.LILY_TODO_MODEL_RECONCILE;
assert.equal(applyModelPlanReconciliation(null, [], ""), 0);

// --- renderer overlay ----------------------------------------------------------
const compactEnd = compactTaskRun(end);
const merged = overlayPlanOnTodos(todos, compactEnd);
assert.deepEqual(merged.map(todoDisplayStatus), ["evidenced", "evidenced", "pending", "evidenced"]);
assert.equal(merged[0].inferred, "model_completed");
assert.equal(todoIcon("evidenced"), "✓");
assert.equal(todoIcon("unconfirmed"), "?");
// Misaligned plan (different length or scaffold ids) → no overlay, never a wrong match.
assert.equal(overlayPlanOnTodos(todos, { plan: [{ id: "execute", inferred: "evidenced" }] })[0].inferred, null);
assert.equal(overlayPlanOnTodos(todos, compactTaskRun(scaffold)).every((t) => !t.inferred), true);
// A model-completed todo never shows an overlay (it is simply done).
assert.equal(overlayPlanOnTodos([{ content: "x", status: "completed" }], { plan: [{ id: "todo_1", inferred: "evidenced" }] })[0].inferred, null);

const translate = (key, p = {}) => ({
  "todo.summary": `Tasks ${p.done}/${p.total}`,
  "todo.evidenced": `+${p.count} evidenced`,
  "todo.unconfirmed": `${p.count} unconfirmed`,
  "todo.stale": `stale ${p.steps}`,
  "task.strip.current": `Now ${p.item}`,
}[key] || key);
const summary = summarizeTodoProgress(merged, compactEnd, translate);
assert.equal(summary, "Tasks 0/4 · +3 evidenced · stale 2", "confirmed count stays honest; evidence and staleness are stated separately");

// Live strip: the same overlay via liveTurn.taskRun (compact shape from task.plan.updated).
const live = createTaskRun({ sessionId: "s5", turnId: "t5" });
applyTaskPlanFromTodos(live, todos);
observePlanTool(live, { id: "l1", name: "bash", input: { command: "mkdir -p /d/0905" }, status: "done" });
observePlanTool(live, { id: "l2", name: "bash", input: { command: "docker pull h/safar-web:fe2cd212" }, status: "running" }, { running: true });
const strip = buildLiveTaskStripModel({
  tools: new Map([["tw1", { name: "todowrite", input: { todos } }]]),
  taskRun: compactTaskRun(live),
}, translate);
assert.equal(strip.visible, true);
assert.deepEqual(strip.items.map(todoDisplayStatus), ["evidenced", "in_progress", "pending", "pending"]);
assert.equal(strip.summary, "Tasks 0/4 · +1 evidenced · Now 拉取 safar-web:fe2cd212 并保存 tar", "the running match becomes the current item; below the staleness threshold no stale label");
// Without any taskRun the strip renders exactly as before (baseline unchanged).
const plain = buildLiveTaskStripModel({ tools: new Map([["tw1", { name: "todowrite", input: { todos } }]]) }, translate);
assert.equal(plain.summary, "Tasks 0/4 · Now 创建 0905 目录");
assert.equal(plain.items.every((t) => !t.inferred), true);

console.log("test-todo-progress-overlay: ok");
