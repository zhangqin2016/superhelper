#!/usr/bin/env node
// turn-start-guard: no exception in the send path may strand a session in a
// non-idle phase ("queued but never dispatches" deadlock), and the stuck-phase
// sweeper must recover orphaned "starting"/"finalizing" states.

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  friendlyStartFailureDetail,
  guardTurnStart,
  recoverStuckTurn,
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
    async _finalize(sessionId, type, payload) {
      if (finalizeImpl) return finalizeImpl(this, sessionId, type, payload);
      const state = this._state(sessionId);
      emitted.push({ sessionId, type, payload });
      clearTurnState(state);
    },
    _emit(sessionId, type, payload) {
      emitted.push({ sessionId, type, payload });
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
  assert(orchestrator.emitted.some((e) => e.type === "turn.failed"));
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
  state.startedAt = Date.now();
  state.updatedAt = Date.now();
  const timer = startStuckPhaseGuard(orchestrator, { sweepMs: 10, stuckStartingMs: 60_000, stuckFinalizingMs: 60_000 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  clearInterval(timer);
  assert.equal(state.phase, "starting", "fresh starting phase must not be touched");
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

console.log("turn-start-guard: ok");
