#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RuntimeEventBus } = require("../src/main/runtime-event-bus.js");
const {
  createTurnTerminalFinalizer,
} = require("../src/main/turn-terminal-finalizer.js");

function activeState(turnId, assistantText = "durable first-winner answer") {
  return {
    sessionId: "session_terminal_cas",
    phase: "running",
    finalizing: false,
    turnId,
    turnGeneration: 1,
    terminalEmitted: false,
    admittedSeq: 1,
    admittedTurnInput: {
      sessionId: "session_terminal_cas",
      turnId,
      ownerScope: "profile:terminal-owner",
      status: "dispatching",
    },
    dispatchAttemptId: `dispatch_${turnId}`,
    characterWorldsSnapshot: null,
    assistantText,
    thinkingText: "",
    contentBlocks: [],
    protocolUnknown: [],
    processEvents: [],
    notices: [],
    usage: null,
    taskContract: null,
    pendingTaskContract: null,
    turnPolicy: null,
    evidenceLedger: null,
    inheritedEvidenceTools: [],
    taskRun: null,
    enginePayload: {
      rawText: "terminal race",
      files: [],
    },
    legacyContextHydrated: false,
    timeline: [],
    activityLabel: null,
    durationMs: null,
    totalCostUsd: null,
    blockIndexToToolId: new Map(),
    currentPayload: null,
    scheduledTask: null,
    tools: new Map(),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    pendingHooks: new Map(),
  };
}

function archive(commits = [], { buildRecordThrows = false } = {}) {
  return {
    buildRecord(_state, type, payload) {
      if (buildRecordThrows) throw new Error("archive builder exploded");
      return {
        type,
        assistantText: payload.assistant || "",
        fileChanges: [],
        resultBlocks: [],
        artifacts: [],
        meta: {},
      };
    },
    commit() {
      commits.push(true);
      return { id: "message_terminal_cas" };
    },
  };
}

async function runScenario({ turnId, markTerminal, durableLookup, assistant = "late loser answer", buildRecordThrows = false }) {
  const state = activeState(turnId, assistant);
  const observed = [];
  const commits = [];
  const bus = new RuntimeEventBus(() => null);
  bus.addObserver((_sessionId, events) => observed.push(...events));
  const ctx = {
    sessionManager: {
      findById: () => ({ id: "session_terminal_cas", projectId: "project" }),
      markTurnInputTerminal: markTerminal,
      getTurnInputByTurnId: durableLookup,
    },
    scheduledTaskManager: null,
  };
  const finalizer = createTurnTerminalFinalizer({
    ctx,
    turnArchive: archive(commits, { buildRecordThrows }),
    taskRunRuntime: { complete() {} },
    subagentRuntime: { clearAllWatches() {} },
    getState: () => state,
    emit: (sessionId, type, payload, opts = {}) => bus.emit(sessionId, {
      type,
      turnId: opts.turnId === undefined ? state.turnId : opts.turnId,
      source: "orchestrator",
      payload,
    })[0],
    scheduleBackgroundCompaction() {},
  });
  await finalizer.finalize("session_terminal_cas", "turn.failed", {
    failed: true,
    assistant,
    errorCode: "LATE_FAILURE",
  });
  return { state, observed, commits };
}

const terminalWinner = await runScenario({
  turnId: "turn_terminal_winner",
  markTerminal: () => ({
    ok: false,
    reason: "TERMINAL_IMMUTABLE",
    turn: {
      sessionId: "session_terminal_cas",
      turnId: "turn_terminal_winner",
      ownerScope: "profile:terminal-owner",
      status: "completed",
      terminalType: "turn.completed",
      terminalAt: 100,
    },
  }),
  durableLookup: () => {
    throw new Error("terminal CAS result already supplied the winner");
  },
});
assert.equal(
  terminalWinner.observed.filter((event) => event.type === "turn.completed").length,
  1,
  "a lost terminal CAS must project the immutable durable first winner",
);
assert.equal(
  terminalWinner.observed.filter((event) => event.type === "turn.failed").length,
  0,
  "a late failure cannot overwrite or project over a durable completion",
);
assert.equal(
  terminalWinner.observed.filter((event) => event.type === "assistant.final").length,
  1,
  "the winning durable result is finalized once",
);
assert.equal(terminalWinner.state.phase, "idle");

const unknown = await runScenario({
  turnId: "turn_terminal_unknown",
  markTerminal: () => {
    throw new Error("terminal database unavailable");
  },
  durableLookup: () => ({
    sessionId: "session_terminal_cas",
    turnId: "turn_terminal_unknown",
    ownerScope: "profile:terminal-owner",
    status: "dispatching",
    dispatchAttemptId: "dispatch_turn_terminal_unknown",
  }),
});
const unknownEvent = unknown.observed.find(
  (event) => event.type === "turn.dispatch_outcome_unknown",
);
assert.ok(unknownEvent, "CAS/query uncertainty emits the registered outcome-unknown event");
assert.equal(unknownEvent.payload.automaticReplay, false);
assert.equal(unknownEvent.payload.manualRecoveryRequired, true);
assert.match(
  unknownEvent.payload.recoveryId,
  /^recovery_turn_terminal_unknown_/,
  "the visible unknown state includes a bounded recovery id",
);
assert.equal(
  unknown.observed.filter((event) => event.type === "assistant.final").length,
  1,
  "outcome uncertainty emits one visible assistant status",
);
assert.equal(
  unknown.observed.filter((event) => event.type === "turn.failed").length,
  1,
  "outcome uncertainty closes the live projection with one visible failure",
);
assert.equal(unknown.state.phase, "idle");

// An empty failure is still a durable conversation event. Without this, a
// failed task with no assistant text/tools disappears after reload because the
// terminal finalizer drops the empty archive record.
const emptyFailure = await runScenario({
  turnId: "turn_empty_failure",
  assistant: "",
  markTerminal: () => ({
    ok: true,
    turn: { status: "failed", terminalType: "turn.failed" },
  }),
  durableLookup: () => null,
});
assert.equal(
  emptyFailure.commits.length,
  1,
  "empty turn.failed must be archived so the failure survives reload",
);

// A post-CAS archive failure must not leave the renderer in a permanent
// finalizing state. The live terminal projection is the fail-open fallback.
const archiveFailure = await runScenario({
  turnId: "turn_archive_failure",
  assistant: "",
  buildRecordThrows: true,
  markTerminal: () => ({
    ok: true,
    turn: { status: "failed", terminalType: "turn.failed" },
  }),
  durableLookup: () => null,
});
assert.equal(archiveFailure.state.phase, "idle", "archive failure must immediately release finalizing");
const archiveFailureEvent = archiveFailure.observed.find((event) => event.type === "turn.failed");
assert.ok(archiveFailureEvent, "archive failure must still produce a terminal event");
assert.equal(archiveFailureEvent.turnId, "turn_archive_failure");
assert.match(
  archiveFailureEvent.payload.assistant,
  /收尾时遇到内部错误/,
  "archive failure must leave an explicit visible recovery message",
);

console.log("turn-terminal-cas-recovery: ok");
