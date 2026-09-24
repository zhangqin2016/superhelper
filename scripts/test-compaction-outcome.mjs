#!/usr/bin/env node
/**
 * A compaction's outcome is what the engine did, not how long Lily waited.
 *
 * Measured 2026-09-23 on one long session: 11 of 11 compactions were recorded
 * as failures at 30s — a transport number in the SDK table that undercut the
 * 90s the session declared — while the engine finished every one in 37–75s.
 * Each was then reported to the user as "skipped", backed off as a recent
 * failure, and, because "last compacted" never advanced, requested again.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };
const tick = () => new Promise((resolve) => setImmediate(resolve));

// session-memory writes the user's profile; the outcome is what is asserted.
const memory = require("../src/main/session-memory.js");
const recorded = [];
memory.markSessionCompacted = (sessionId, details) => { recorded.push({ kind: "compacted", sessionId, ...details }); };
memory.markSessionCompactionFailed = (sessionId, details) => { recorded.push({ kind: "failed", sessionId, ...details }); };
const quiet = console.warn;
console.warn = () => {};
console.info = () => {};

const { compactWithOutcome, isCompacting } = require("../src/main/compaction-outcome.js");
const { compactionTimeoutMs, DEFAULT_COMPACTION_TIMEOUT_MS } = require("../src/main/runtime/compaction-timeout.js");
const { createOpencodeSdkSession } = require("../src/main/runtime/opencode-sdk-session.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function timedOut(settlement) {
  const error = new Error("summarize failed: OPENCODE_HTTP_TIMEOUT after 90000ms");
  error.code = "OPENCODE_HTTP_TIMEOUT";
  error.settlement = settlement;
  return error;
}

// ------------------------------------------------------------- one bound
{
  const seen = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { seen.push(ms); return realSetTimeout(fn, 0, ...rest); };
  try {
    const sdk = createOpencodeSdkSession({ session: { summarize: () => new Promise(() => {}) } }, "/tmp");
    await sdk.summarize("ses", {}).catch(() => {});
  } finally { globalThis.setTimeout = realSetTimeout; }
  assert.deepEqual(seen, [compactionTimeoutMs()], "the SDK waits exactly the compaction bound, not a transport number of its own");
  assert.equal(compactionTimeoutMs(), DEFAULT_COMPACTION_TIMEOUT_MS);
  assert.equal(compactionTimeoutMs({ LILY_COMPACTION_TIMEOUT_MS: "5000" }), 15_000, "floored so a real summary is never cut short");
  assert.equal(compactionTimeoutMs({ LILY_COMPACTION_TIMEOUT_MS: "240000" }), 240_000, "and an operator can extend it");
  const source = fs.readFileSync(new URL("../src/main/runtime/opencode-sdk-session.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*summarize:\s*\d/m, "the transport table no longer carries a summarize number");
  check("the summarize wait has one owner, and every layer uses it");
}

// ------------------------------------------------------- within the wait
{
  recorded.length = 0;
  const owner = {};
  const ok = await compactWithOutcome(owner, { sessionId: "s1", server: { summarize: async () => ({}) }, body: { reason: "long_session" } });
  assert.equal(ok, true);
  assert.deepEqual(recorded.map((r) => r.kind), ["compacted"]);
  assert.equal(isCompacting(owner), false);
  check("a summary that lands within the wait is recorded as compacted, as before");
}

// ------------------------------------------- the wait ends, the engine finishes
{
  recorded.length = 0;
  const owner = {};
  const engine = deferred();
  const ok = await compactWithOutcome(owner, {
    sessionId: "s2",
    server: { summarize: async () => { throw timedOut(engine.promise); } },
    body: { reason: "long_session" },
  });
  assert.equal(ok, false, "this turn still proceeds without it — fail-open is unchanged");
  assert.equal(recorded.length, 0, "giving up waiting records nothing: not a failure, not yet a success");
  assert.equal(isCompacting(owner), true, "the session knows a summary is still running");
  engine.resolve({ data: true });
  await tick();
  assert.deepEqual(recorded.map((r) => [r.kind, r.late]), [["compacted", true]], "the engine's real result is what is recorded");
  assert.equal(isCompacting(owner), false);
  check("a summary that finishes after the wait is credited as compacted, not as a failure");
}

{
  recorded.length = 0;
  const owner = {};
  const engine = deferred();
  await compactWithOutcome(owner, {
    sessionId: "s3",
    server: { summarize: async () => { throw timedOut(engine.promise); } },
    body: { reason: "long_session", providerID: "p", modelID: "m" },
  });
  // The settlement is the engine work lease: a serve that dies rejects it.
  engine.reject(new Error("serve exited before the summary landed"));
  await tick();
  assert.deepEqual(recorded.map((r) => r.kind), ["failed"]);
  assert.match(recorded[0].error, /serve exited/, "with the real cause, not the timeout");
  assert.equal(isCompacting(owner), false);
  check("a summary that later fails is recorded as failed, with its own cause");
}

{
  recorded.length = 0;
  const ok = await compactWithOutcome({}, { sessionId: "s4", server: { summarize: async () => { throw new Error("401 unauthorized"); } }, body: {} });
  assert.equal(ok, false);
  assert.deepEqual(recorded.map((r) => r.kind), ["failed"], "an error that is not a timeout is still a failure, at once");
  check("a real failure is still recorded immediately");
}

// --------------------------------------------- no second summary over the first
{
  const { OpencodeAgentSession } = require("../src/main/opencode-agent-session.js");
  const engine = deferred();
  let calls = 0;
  const server = { summarize: async () => { calls += 1; throw timedOut(engine.promise); }, terminate() {} };
  const session = new OpencodeAgentSession("compacting_guard", { createServer: () => server });
  session._server = server;
  assert.equal(await session.compactContext({ reason: "long_session" }), false);
  assert.equal(session.isCompacting(), true);
  assert.equal(await session.compactContext({ reason: "long_session" }), false);
  assert.equal(calls, 1, "while the engine is still summarizing, no second summary is started");

  const { decideBackgroundCompaction } = require("../src/main/context-budget-manager.js");
  const decision = decideBackgroundCompaction({
    capabilities: { nativeCompaction: true },
    model: { providerID: "p", modelID: "m", contextWindowTokens: 32_768 },
    runner: { alive: true, canStart: true, busy: false, compacting: true },
    sessionSummary: { turnCount: 80 },
  });
  assert.deepEqual([decision.action, decision.reason], ["skip", "compaction_in_progress"], "and the budget says why it waited");
  engine.resolve({ data: true });
  await tick();
  assert.equal(session.isCompacting(), false);
  session.terminate?.();
  check("a compaction still running blocks a second one, and the decision names it");
}

// ----------------------------------------------- what the caller tells the user
{
  const url = new URL("../src/main/context-compaction-runtime.js", import.meta.url);
  const nativeRequire = createRequire(url);
  const failures = [];
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(url, "utf8"), {
    module: mod, exports: mod.exports, process, Buffer, console, setTimeout, clearTimeout, queueMicrotask,
    require: (id) => id === "./session-memory"
      ? {
        readSessionSummary: () => ({ turnCount: 80, retainedContextTokens: 90_000 }),
        writeSessionSummary() {},
        markSessionCompactionFailed: (...args) => failures.push(args),
      }
      : id === "./logger" ? { getLogger: () => ({ warn() {}, info() {} }) } : nativeRequire(id),
  }, { filename: url.pathname });
  const notices = [];
  const runtime = mod.exports.createContextCompactionRuntime({
    emit: (_sessionId, type, payload) => { if (type === "engine.notice") notices.push(payload.notice); },
  });
  let compacting = false;
  const runner = {
    spawnOptions: { model: { providerID: "p", modelID: "m", contextWindowTokens: 32_000 } },
    isAlive: () => true, isBusy: () => false, isCompacting: () => compacting,
    compactContext: async () => { compacting = true; return false; },
  };
  const result = await runtime.maybeCompactBeforeTurn("s", runner, { text: "继续" });
  assert.equal(result.action, "compact");
  assert.equal(result.compactionPending, true);
  assert.equal(failures.length, 0, "a summary still running is not recorded as a false compaction");
  const last = notices.at(-1);
  assert.equal(last.code, "compactBoundary", "the user is not told it was skipped");
  assert.equal(last.done, true, "and the progress spinner ends");
  assert.match(last.detail, /still finishing/);

  compacting = false;
  const failed = await runtime.maybeCompactBeforeTurn("s", { ...runner, compactContext: async () => false }, { text: "继续" });
  assert.equal(failed.compacted, false);
  assert.equal(failures.length, 1, "a compaction that really did nothing is still recorded");
  assert.equal(notices.at(-1).code, "compactFailed");
  check("the caller distinguishes still-running from failed, in the record and to the user");
}

console.warn = quiet;
console.log(`compaction-outcome: ok (${checks} checks)`);
