#!/usr/bin/env node
// Model recovery watch + parent-closure deferral: a model-silent failure does
// not burn a continuation round against the same dead upstream; it waits for
// a successful readiness probe (bounded), then runs the recovery exactly once.
// Eligibility now admits zero-evidence model-silent failures and the long
// analysis/extraction task types. The ping helper treats a 200 HTML page as
// "not ready". [gate: task-completion-integrity]
// Run: node scripts/test-model-recovery-watch.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const watchModule = require("../src/main/model-recovery-watch.js");
const { shouldRecoverParentClosure, hasExecutionIntent, isModelSilentFailure } = require("../src/main/parent-task-closure.js");
const { pingModel, routeFromEnv } = require("../src/main/model-ping.js");

let checks = 0;
async function check(name, fn) { await fn(); checks += 1; console.log(`ok - ${name}`); }

await check("watch probes on a cadence, fires onReady once, and is idempotent per key", async () => {
  watchModule.resetModelRecoveryWatchesForTests();
  let probes = 0;
  const ready = [];
  const timers = [];
  const watch = watchModule.startModelRecoveryWatch({
    key: "parent-closure:s1",
    probe: async () => { probes += 1; return { ok: probes >= 3 }; },
    onReady: async (info) => ready.push(info),
    intervalMs: 1_000,
    maxAttempts: 10,
    setTimeoutImpl: (fn) => { timers.push(fn); return { unref() {} }; },
    clearTimeoutImpl: () => {},
  });
  assert.ok(watch);
  assert.equal(watchModule.hasModelRecoveryWatch("parent-closure:s1"), true);
  await watch.probeNow();
  await watch.probeNow();
  assert.equal(ready.length, 0);
  await watch.probeNow();
  assert.equal(ready.length, 1);
  assert.equal(ready[0].attempts, 3);
  assert.equal(watch.done, true);
  assert.equal(watchModule.hasModelRecoveryWatch("parent-closure:s1"), false, "a finished watch releases its key");
  await watch.probeNow();
  assert.equal(ready.length, 1, "never fires twice");
});

await check("watch gives up after maxAttempts and reports it; cancel stops silently; kill switch disables", async () => {
  watchModule.resetModelRecoveryWatchesForTests();
  const gaveUp = [];
  const watch = watchModule.startModelRecoveryWatch({
    key: "k2", probe: async () => ({ ok: false, reason: "TIMEOUT" }), onReady: async () => { throw new Error("must not"); },
    onGiveUp: (info) => gaveUp.push(info), intervalMs: 1_000, maxAttempts: 2,
    setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl: () => {},
  });
  await watch.probeNow();
  await watch.probeNow();
  assert.equal(gaveUp.length, 1);
  assert.equal(gaveUp[0].attempts, 2);
  const second = watchModule.startModelRecoveryWatch({ key: "k3", probe: async () => ({ ok: true }), onReady: async () => {}, setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl: () => {} });
  assert.equal(watchModule.cancelModelRecoveryWatch("k3"), true);
  assert.equal(second.done, true);
  process.env.LILY_MODEL_RECOVERY_WATCH = "0";
  assert.equal(watchModule.startModelRecoveryWatch({ key: "k4", probe: async () => ({ ok: true }), onReady: async () => {} }), null);
  delete process.env.LILY_MODEL_RECOVERY_WATCH;
});

await check("eligibility: model-silent failures with zero evidence are ELIGIBLE_MODEL_SILENT; other zero-evidence failures still are not", async () => {
  const state = { turnId: "turn-1", tools: new Map(), pendingPermissions: new Map(), pendingQuestions: new Map(), pendingHooks: new Map() };
  const contract = { active: true, taskType: "code_change", categories: [] };
  const silent = shouldRecoverParentClosure({ sessionId: "s", taskContract: contract, state, payload: { failed: true, errorCode: "MODEL_NO_RESPONSE" } });
  assert.equal(silent.ok, true);
  assert.equal(silent.reason, "ELIGIBLE_MODEL_SILENT");
  assert.equal(silent.modelSilent, true);
  const other = shouldRecoverParentClosure({ sessionId: "s", taskContract: contract, state, payload: { failed: true, errorCode: "MODEL_CONNECTION_FAILED" } });
  assert.equal(other.ok, false);
  assert.equal(other.reason, "NO_EXECUTION_EVIDENCE");
  assert.equal(isModelSilentFailure({ noFirstResponse: true }), true);
  assert.equal(isModelSilentFailure({ errorCode: "TRUNCATED_TURN_END" }), false);
});

await check("eligibility: CUT-OFF long analysis/extraction/document work may continue; read-only tasks stay read-only", async () => {
  const tools = new Map([["a", { id: "a", name: "read", status: "done" }], ["b", { id: "b", name: "grep", status: "done" }], ["c", { id: "c", name: "read", status: "done" }]]);
  const baseState = { turnId: "turn-2", pendingPermissions: new Map(), pendingQuestions: new Map(), pendingHooks: new Map() };
  for (const taskType of ["content_extraction", "architecture_audit", "document_work", "bug_investigation"]) {
    const contract = { active: true, taskType, categories: [] };
    assert.equal(hasExecutionIntent(contract), false, `${taskType} is not an execution intent`);
    const stalledWithProgress = shouldRecoverParentClosure({ sessionId: "s", taskContract: contract, state: { ...baseState, tools }, payload: { stalled: true } });
    assert.equal(stalledWithProgress.ok, true, `${taskType} stalled after real progress continues`);
    const cleanEnd = shouldRecoverParentClosure({ sessionId: "s", taskContract: contract, state: { ...baseState, tools }, payload: { code: 0 } });
    assert.equal(cleanEnd.reason, "NON_EXECUTION_TASK", `${taskType} that simply finished is not re-entered`);
    const stalledNoProgress = shouldRecoverParentClosure({ sessionId: "s", taskContract: contract, state: { ...baseState, tools: new Map([["a", { id: "a", name: "read", status: "done" }]]) }, payload: { stalled: true } });
    assert.equal(stalledNoProgress.reason, "NON_EXECUTION_TASK", `${taskType} with one read is not long-running work`);
    const silent = shouldRecoverParentClosure({ sessionId: "s", taskContract: contract, state: { ...baseState, tools: new Map() }, payload: { failed: true, errorCode: "MODEL_NO_RESPONSE" } });
    assert.equal(silent.reason, "ELIGIBLE_MODEL_SILENT", `${taskType} killed by a silent model waits for recovery`);
  }
  assert.equal(shouldRecoverParentClosure({ sessionId: "s", taskContract: { active: true, taskType: "general", categories: [] }, state: { ...baseState, tools }, payload: { stalled: true } }).reason, "NON_EXECUTION_TASK");
  assert.equal(hasExecutionIntent({ active: false, taskType: "code_change" }), false);
});

await check("ping: derives the route from the env, treats non-2xx / HTML / timeout as not ready, JSON 2xx as ready", async () => {
  assert.equal(routeFromEnv({}), null);
  const env = { LILY_API_BASE_URL: "https://gw.test/llm/deepseek/v1/", LILY_API_KEY: "k", LILY_MODEL: "deepseek-v4-flash" };
  const route = routeFromEnv(env);
  assert.equal(route.baseURL, "https://gw.test/llm/deepseek/v1");
  let seen = null;
  const ok = await pingModel({ env, fetch: async (url, init) => { seen = { url, init }; return { status: 200, text: async () => "{\"choices\":[]}" }; } });
  assert.equal(ok.ok, true);
  assert.equal(seen.url, "https://gw.test/llm/deepseek/v1/chat/completions");
  assert.equal(seen.init.headers.Authorization, "Bearer k");
  assert.equal(JSON.parse(seen.init.body).max_tokens, 1);
  const html = await pingModel({ env, fetch: async () => ({ status: 200, text: async () => "<html>error</html>" }) });
  assert.equal(html.ok, false);
  assert.equal(html.reason, "NON_JSON_BODY");
  const down = await pingModel({ env, fetch: async () => ({ status: 503, text: async () => "" }) });
  assert.equal(down.reason, "HTTP_503");
  const hang = await pingModel({ env, timeoutMs: 1_000, fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
  assert.equal(hang.ok, false);
  assert.equal(hang.reason, "TIMEOUT");
  const anthropic = await pingModel({ env: { ...env, LILY_OPENCODE_PROTOCOL: "anthropic" }, fetch: async (url, init) => { seen = { url, init }; return { status: 200, text: async () => "{}" }; } });
  assert.equal(anthropic.ok, true);
  assert.match(seen.url, /\/messages$/);
  assert.equal(seen.init.headers["x-api-key"], "k");
});

console.log(`\n${checks} checks passed (model recovery watch)`);
