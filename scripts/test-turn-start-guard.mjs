#!/usr/bin/env node
// turn-start-guard: no exception in the send path may strand a session in a
// non-idle phase ("queued but never dispatches" deadlock), and the stuck-phase
// sweeper must recover orphaned "starting"/"finalizing" states.

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  friendlyStartFailureDetail,
  cancelTurnStart,
  guardLocalAssistantTurn,
  guardTurnStart,
  recoverStuckTurn,
  isCurrentTurnStart,
  startStuckPhaseGuard,
} = require("../src/main/turn-start-guard.js");
const { clearTurnState } = require("../src/main/turn-terminal-finalizer.js");

function makeOrchestrator({ startImpl, finalizeImpl } = {}) {
  const emitted = [];
  const orchestrator = {
    states: new Map(),
    emitted,
    afterFinalizeCalls: 0,
    _state(sessionId) {
      if (!this.states.has(sessionId)) {
        this.states.set(sessionId, {
          phase: "idle",
          turnId: null,
          terminalEmitted: false,
          queue: [],
          tools: new Map(),
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          pendingHooks: new Map(),
        });
      }
      return this.states.get(sessionId);
    },
    async _startTurn(session, text) {
      if (startImpl) return startImpl(this, session, text);
      return { ok: true };
    },
    async _startLocalAssistantTurn(session, text) {
      if (startImpl) return startImpl(this, session, text);
      return { ok: true, localAssistant: true };
    },
    async _finalize(sessionId, type, payload) {
      if (finalizeImpl) return finalizeImpl(this, sessionId, type, payload);
      const state = this._state(sessionId);
      emitted.push({ sessionId, type, payload });
      clearTurnState(state);
    },
    _emit(sessionId, type, payload, opts = {}) {
      const turnId = opts.turnId === undefined ? this._state(sessionId).turnId : opts.turnId;
      if (!turnId && !["session.hydrated", "resume.updated", "resume.invalid", "queue.updated"].includes(type)) {
        return null;
      }
      emitted.push({ sessionId, type, payload, turnId });
    },
    _afterTurnFinalized() {
      this.afterFinalizeCalls += 1;
    },
  };
  return orchestrator;
}

// 1. _startTurn throws AFTER the phase was pinned → recovered, not wedged.
{
  const orchestrator = makeOrchestrator({
    startImpl: (orch, session) => {
      const state = orch._state(session.id);
      state.phase = "starting";
      state.turnId = "turn_1";
      state.turnGeneration = 1;
      state.startedAt = Date.now();
      state.updatedAt = Date.now();
      throw new Error("SQLITE_FULL: database or disk is full");
    },
  });
  const result = await guardTurnStart(orchestrator, { id: "s1" }, "hello", [], {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "TURN_START_FAILED");
  assert(/磁盘空间不足/.test(result.detail), "raw sqlite error must become user language");
  const state = orchestrator._state("s1");
  assert.equal(state.phase, "idle", "phase must return to idle");
  assert.equal(state.turnId, null);
  assert(
    orchestrator.emitted.some((e) => e.type === "turn.failed" && e.payload.errorCode === "TURN_START_FAILED"),
    "a terminal turn.failed must be emitted so the renderer exits loading",
  );
  assert.equal(orchestrator.afterFinalizeCalls, 1, "queue must progress after recovery");
}

// 2. finalize itself throws mid-way → hard reset still guarantees idle.
{
  const orchestrator = makeOrchestrator({
    startImpl: (orch, session) => {
      const state = orch._state(session.id);
      state.phase = "starting";
      state.turnId = "turn_2";
      state.turnGeneration = 1;
      throw new Error("EACCES: permission denied");
    },
    finalizeImpl: () => {
      throw new Error("buildRecord exploded");
    },
  });
  const result = await guardTurnStart(orchestrator, { id: "s2" }, "hello", [], {});
  assert.equal(result.ok, false);
  const state = orchestrator._state("s2");
  assert.equal(state.phase, "idle", "even a broken finalize must not wedge the phase");
  const hardResetFailure = orchestrator.emitted.find((e) => e.type === "turn.failed");
  assert(hardResetFailure, "hard reset must emit a terminal failure");
  assert.equal(hardResetFailure.turnId, "turn_2", "hard reset must preserve the original turn id");
}

// 2b. The local assistant path uses the same recovery boundary as engine starts.
{
  const orchestrator = makeOrchestrator({
    startImpl: (orch, session) => {
      const state = orch._state(session.id);
      state.phase = "starting";
      state.turnId = "local_turn_failed";
      state.turnGeneration = 1;
      throw new Error("local archive failed");
    },
  });
  const result = await guardLocalAssistantTurn(orchestrator, { id: "s_local" }, "local", [], {});
  assert.equal(result.ok, false);
  assert.equal(orchestrator._state("s_local").phase, "idle");
  assert(
    orchestrator.emitted.some((event) => event.type === "turn.failed" && event.payload.errorCode === "TURN_START_FAILED"),
    "local assistant start failure must emit a terminal event",
  );
}

// 2c. A second start cannot overwrite a first start that is still in preflight.
{
  let releaseStart;
  const startReady = new Promise((resolve) => { releaseStart = resolve; });
  const orchestrator = makeOrchestrator({
    startImpl: async () => {
      await startReady;
      return { ok: true };
    },
  });
  const first = guardTurnStart(orchestrator, { id: "s_start_lock" }, "first", [], {});
  await Promise.resolve();
  const second = await guardTurnStart(orchestrator, { id: "s_start_lock" }, "second", [], {});
  assert.equal(second.error, "TURN_START_BUSY");
  releaseStart();
  await first;
  assert.equal(orchestrator._state("s_start_lock").startInFlight, null);
}

// 2d. A priority send can cancel a start that is still in preflight, before
// the start path has assigned a turn id or entered the visible starting phase.
{
  let releaseStart;
  const startReady = new Promise((resolve) => { releaseStart = resolve; });
  const orchestrator = makeOrchestrator({
    startImpl: async () => {
      await startReady;
      return { ok: true };
    },
  });
  const first = guardTurnStart(orchestrator, { id: "s_start_cancel" }, "first", [], {});
  await Promise.resolve();
  assert.equal(cancelTurnStart(orchestrator, "s_start_cancel"), true);
  assert.equal(orchestrator._state("s_start_cancel").startInFlight.cancelled, true);
  releaseStart();
  await first;
  assert.equal(orchestrator._state("s_start_cancel").startInFlight, null);
}

// 3. Exception before a turnId exists → silent reset, no phantom bubble.
{
  const orchestrator = makeOrchestrator({
    startImpl: () => {
      throw new Error("readMemoryPreferences is not a function");
    },
  });
  const result = await guardTurnStart(orchestrator, { id: "s3" }, "hi", [], {});
  assert.equal(result.ok, false);
  assert.equal(orchestrator._state("s3").phase, "idle");
  // Phase was never pinned, so no terminal event and no forced queue pass —
  // but the caller still gets a clean structured failure.
  assert.equal(orchestrator.emitted.length, 0);
}

// 4. Stuck-phase sweeper recovers an orphaned "starting" state.
{
  const orchestrator = makeOrchestrator();
  const state = orchestrator._state("s4");
  state.phase = "starting";
  state.turnId = "turn_4";
  state.turnGeneration = 1;
  state.startedAt = Date.now() - 10_000;
  state.updatedAt = Date.now() - 10_000;
  const timer = startStuckPhaseGuard(orchestrator, { sweepMs: 10, stuckStartingMs: 50, stuckFinalizingMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  clearInterval(timer);
  assert.equal(state.phase, "idle", "sweeper must recover stuck starting phase");
  assert(
    orchestrator.emitted.some((e) => e.type === "turn.failed" && e.payload.errorCode === "TURN_STUCK_RESET"),
    "sweeper recovery must emit a terminal event",
  );
}

// 5. Sweeper leaves healthy/recent states alone.
{
  const orchestrator = makeOrchestrator();
  const state = orchestrator._state("s5");
  state.phase = "starting";
  state.turnId = "turn_5";
  state.turnGeneration = 1;
  state.startedAt = Date.now();
  state.updatedAt = Date.now();
  const timer = startStuckPhaseGuard(orchestrator, { sweepMs: 10, stuckStartingMs: 60_000, stuckFinalizingMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  clearInterval(timer);
  assert.equal(state.phase, "starting", "fresh starting phase must not be touched");
}

// A watchdog recovery must never finalize a newer turn that replaced the
// stale target while the original finalizer was awaiting I/O.
{
  let releaseFinalize;
  const finalizeReady = new Promise((resolve) => { releaseFinalize = resolve; });
  const orchestrator = makeOrchestrator({
    finalizeImpl: async (orch) => {
      await finalizeReady;
      const state = orch._state("s_stale_recovery");
      state.phase = "running";
      state.turnId = "turn_newer";
      state.turnGeneration = 2;
    },
  });
  const state = orchestrator._state("s_stale_recovery");
  state.phase = "starting";
  state.turnId = "turn_old";
  state.turnGeneration = 1;
  const recovery = recoverStuckTurn(orchestrator, "s_stale_recovery", {
    errorCode: "TURN_STUCK_RESET",
    err: new Error("old turn stalled"),
    expectedTurnId: "turn_old",
    expectedTurnGeneration: 1,
  });
  await Promise.resolve();
  releaseFinalize();
  await recovery;
  assert.equal(state.turnId, "turn_newer", "stale recovery must not reset a newer turn");
  assert.equal(state.phase, "running", "stale recovery must not finalize a newer turn");
  assert.equal(orchestrator.afterFinalizeCalls, 0, "stale recovery must not advance the newer turn queue");
}

// 6. Friendly detail mappings.
assert(/磁盘空间不足/.test(friendlyStartFailureDetail(new Error("SQLITE_FULL"))));
assert(/权限/.test(friendlyStartFailureDetail(new Error("EACCES: permission denied, open '/x'"))));
assert(/被其他进程占用/.test(friendlyStartFailureDetail(new Error("SQLITE_BUSY: database is locked"))));
assert(/内部错误/.test(friendlyStartFailureDetail(new Error("totally unexpected"))));

// 7. recoverStuckTurn on an already-idle state is a no-op.
{
  const orchestrator = makeOrchestrator();
  await recoverStuckTurn(orchestrator, "s7", { errorCode: "TURN_STUCK_RESET", err: new Error("x") });
  assert.equal(orchestrator.emitted.length, 0);
  assert.equal(orchestrator.afterFinalizeCalls, 0);
}

// 8. A preflight continuation from an auto-recovered turn is stale and must
// never be allowed to dispatch into a newer or already-cleared turn.
{
  const state = { phase: "starting", turnId: "turn_8", turnGeneration: 3, terminalEmitted: false };
  assert.equal(isCurrentTurnStart(state, "turn_8", 3), true);
  state.phase = "idle";
  assert.equal(isCurrentTurnStart(state, "turn_8", 3), false);
  state.phase = "starting";
  state.turnId = "turn_9";
  state.turnGeneration = 4;
  assert.equal(isCurrentTurnStart(state, "turn_8", 3), false);
  state.turnId = "turn_8";
  state.turnGeneration = 3;
  state.terminalEmitted = true;
  assert.equal(isCurrentTurnStart(state, "turn_8", 3), false);
  state.terminalEmitted = false;
  state.startInFlight = { cancelled: true };
  assert.equal(isCurrentTurnStart(state, "turn_8", 3), false);
}

// 9. Watchdog and send-path recovery are serialized per session. A second
// recovery must not enter finalize or reset state while the first awaits I/O.
{
  let releaseFinalize;
  let finalizeCalls = 0;
  const finalizeReady = new Promise((resolve) => { releaseFinalize = resolve; });
  const orchestrator = makeOrchestrator({
    finalizeImpl: async () => {
      finalizeCalls += 1;
      await finalizeReady;
    },
  });
  const state = orchestrator._state("s_concurrent_recovery");
  state.phase = "finalizing";
  state.turnId = "turn_same";
  state.turnGeneration = 7;
  const first = recoverStuckTurn(orchestrator, "s_concurrent_recovery", {
    errorCode: "TURN_STUCK_RESET",
    err: new Error("first recovery"),
    expectedTurnId: "turn_same",
    expectedTurnGeneration: 7,
  });
  const second = recoverStuckTurn(orchestrator, "s_concurrent_recovery", {
    errorCode: "TURN_START_FAILED",
    err: new Error("racing recovery"),
    expectedTurnId: "turn_same",
    expectedTurnGeneration: 7,
  });
  assert.strictEqual(first, second, "concurrent recovery must share one in-flight promise");
  await Promise.resolve();
  assert.equal(finalizeCalls, 1, "concurrent recovery must finalize exactly once");
  releaseFinalize();
  await first;
  assert.equal(state.phase, "idle");
  assert.equal(state.recoveryInFlight, null, "recovery lock must release after completion");
}

console.log("turn-start-guard: ok");
