#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createExternalCommandRuntime } = require("../src/main/external-command-runtime.js");

const state = { queue: [] };
const queueEmits = [];
const dispatches = [];
let queueSequence = 0;
let firstDurableTurn = null;
const durableLookupIdentities = [];
const runtime = createExternalCommandRuntime({
  ledgerStore: {
    loadSync() { throw new Error("corrupted ledger"); },
    scheduleFlush() { throw new Error("must not overwrite a corrupted ledger"); },
  },
  findSession: (sessionId) => sessionId === "session_1" ? { id: sessionId } : null,
  getState: () => state,
  createQueueId: () => `queue_${++queueSequence}`,
  buildQueueOptions: (value) => ({ ...value, normalized: true }),
  lookupDurableExternalIdentity: (sessionId, identity) => {
    durableLookupIdentities.push({ sessionId, identity });
    return identity.desktopDeviceId === "desktop_1"
      && identity.mobileDeviceId === "mobile_1"
      && identity.idempotencyKey === "idempotency_1"
      ? firstDurableTurn
      : null;
  },
  admitQueueItem: (_session, item) => {
    firstDurableTurn = {
      turnId: "turn_command_1",
      sessionId: "session_1",
      status: "admitted",
      externalCommandId: "command_1",
      externalIdempotencyKey: "idempotency_1",
      externalPayloadHash: "payload_1",
      externalDesktopDeviceId: "desktop_1",
      externalMobileDeviceId: "mobile_1",
      metadata: { queueRecovery: { queueItemId: item.id } },
    };
    item.admittedTurnInput = firstDurableTurn;
    return { ok: true, inserted: true, duplicate: false, turn: firstDurableTurn };
  },
  emitQueue: (sessionId) => queueEmits.push(sessionId),
  dispatchNext: (sessionId) => dispatches.push(sessionId),
});

const envelope = {
  commandId: "command_1",
  idempotencyKey: "idempotency_1",
  payloadHash: "payload_1",
  lilySessionId: "session_1",
  desktopDeviceId: "desktop_1",
  mobileDeviceId: "mobile_1",
  remoteSessionId: "remote_1",
  text: "Run the queued task",
  mode: "queue",
};

const admitted = await runtime.admit(envelope);
assert.equal(admitted.ok, true, "corrupted durable state falls back to in-memory admission");
assert.equal(admitted.state, "admitted");
assert.equal(state.queue.length, 1);
assert.equal(state.queue[0].options.queueOrigin, "mobile_command");
assert.equal(state.queue[0].options.normalized, true);
assert.equal(state.queue[0].options.externalCommand.commandId, "command_1");
assert.deepEqual(queueEmits, ["session_1"]);
assert.deepEqual(dispatches, ["session_1"]);

const replay = await runtime.admit(envelope);
assert.equal(replay.ok, true);
assert.equal(state.queue.length, 1, "in-memory fallback still preserves exactly-once admission");
assert.deepEqual(
  durableLookupIdentities[0],
  {
    sessionId: "session_1",
    identity: {
      desktopDeviceId: "desktop_1",
      mobileDeviceId: "mobile_1",
      idempotencyKey: "idempotency_1",
    },
  },
  "durable lookup uses the contract device tuple instead of commandId",
);

const replayWithDifferentCommandId = await runtime.admit({
  ...envelope,
  commandId: "command_renamed_by_retry",
});
assert.equal(replayWithDifferentCommandId.ok, true);
assert.equal(
  replayWithDifferentCommandId.commandId,
  "command_1",
  "same tuple and payload returns the original persisted command record",
);
assert.equal(state.queue.length, 1, "a changed commandId cannot bypass device-tuple idempotency");

const tupleConflict = await runtime.admit({
  ...envelope,
  commandId: "command_conflicting_retry",
  payloadHash: "payload_conflict",
});
assert.deepEqual(
  tupleConflict,
  { ok: false, code: "IDEMPOTENCY_CONFLICT" },
  "same device tuple with a different payload is rejected without re-admission",
);

const absent = await runtime.admit({
  ...envelope,
  commandId: "command_absent",
  idempotencyKey: "idempotency_absent",
  payloadHash: "payload_absent",
  lilySessionId: "missing",
});
assert.equal(absent.ok, false);
assert.equal(absent.code, "SESSION_ABSENT");

const brokenStateRuntime = createExternalCommandRuntime({
  ledgerStore: { loadSync: () => new Map(), scheduleFlush: () => {} },
  findSession: () => ({ id: "session_1" }),
  getState: () => { throw new Error("state unavailable"); },
  admitQueueItem: (_session, item) => {
    item.admittedTurnInput = { turnId: "turn_broken_state", status: "admitted" };
    return {
      ok: true,
      inserted: true,
      duplicate: false,
      turn: item.admittedTurnInput,
    };
  },
});
const failedOpen = await brokenStateRuntime.admit(envelope);
assert.deepEqual(failedOpen, { ok: false, code: "COMMAND_ADMISSION_ERROR" });

let durableTurn = {
  turnId: "turn_command_reconcile",
  sessionId: "session_1",
  status: "dispatching",
  dispatchAttemptId: "dispatch_command_reconcile",
  dispatchStartedAt: 1234,
  acceptedAt: null,
  terminalAt: null,
  terminalType: null,
  errorCode: null,
  externalCommandId: "command_1",
  externalIdempotencyKey: "idempotency_1",
  externalPayloadHash: "payload_1",
  externalDesktopDeviceId: "desktop_1",
  externalMobileDeviceId: "mobile_1",
};
const durableLedger = new Map([
  ["session_1", new Map([[
    "command_1",
    {
      ...envelope,
      lilySessionId: "session_1",
      requestedMode: "queue",
      effectiveMode: "queue",
      state: "admitted",
      turnId: durableTurn.turnId,
      queueItemId: "queue_reconcile",
    },
  ]])],
]);
const reconciledRuntime = createExternalCommandRuntime({
  ledgerStore: {
    loadSync: () => durableLedger,
    flushSync: () => true,
    scheduleFlush: () => {},
  },
  findSession: () => ({ id: "session_1" }),
  getState: () => ({ queue: [] }),
  lookupDurableExternalIdentity: (_sessionId, identity) => (
    identity.desktopDeviceId === "desktop_1"
      && identity.mobileDeviceId === "mobile_1"
      && identity.idempotencyKey === "idempotency_1"
      ? durableTurn
      : null
  ),
});
const dispatchingReplay = await reconciledRuntime.admit(envelope);
assert.equal(dispatchingReplay.state, "dispatching");
assert.equal(dispatchingReplay.outcomeUnknown, false);
assert.equal(dispatchingReplay.dispatchAttemptId, "dispatch_command_reconcile");
assert.equal(dispatchingReplay.dispatchStartedAt, 1234);
assert.equal(
  reconciledRuntime.ledgers.get("session_1").get("command_1").state,
  "dispatching",
  "the durable turn state must repair a stale mobile ledger",
);

durableTurn = {
  ...durableTurn,
  status: "outcome_unknown",
  outcomeUnknown: true,
};
const dispatchUnknownReplay = await reconciledRuntime.admit(envelope);
assert.equal(dispatchUnknownReplay.state, "dispatch_unknown");
assert.equal(dispatchUnknownReplay.outcomeUnknown, true);

durableTurn = {
  ...durableTurn,
  status: "promoted",
  outcomeUnknown: false,
  acceptedAt: 2345,
};
const promotedReplay = await reconciledRuntime.admit(envelope);
assert.equal(promotedReplay.state, "engine_accepted");
assert.equal(promotedReplay.engineAcceptedAt, 2345);
assert.equal(promotedReplay.outcomeUnknown, false);

durableTurn = {
  ...durableTurn,
  status: "accepted",
};
const acceptedReplay = await reconciledRuntime.admit(envelope);
assert.equal(acceptedReplay.state, "engine_accepted");
assert.equal(acceptedReplay.outcomeUnknown, false);

durableTurn = {
  ...durableTurn,
  status: "completed",
  terminalAt: 3456,
  terminalType: "turn.completed",
};
const completedReplay = await reconciledRuntime.admit(envelope);
assert.equal(completedReplay.state, "terminal");
assert.equal(completedReplay.outcomeUnknown, false);
assert.equal(completedReplay.terminalType, "completed");

durableTurn = {
  ...durableTurn,
  status: "failed",
  terminalAt: 4567,
  terminalType: "turn.failed",
  errorCode: "ENGINE_ERROR",
};
const failedReplay = await reconciledRuntime.admit(envelope);
assert.equal(failedReplay.state, "terminal");
assert.equal(failedReplay.terminalType, "failed");
assert.equal(failedReplay.terminalError, "ENGINE_ERROR");

durableTurn = {
  ...durableTurn,
  status: "interrupted",
  terminalAt: 5678,
  terminalType: "turn.interrupted",
  errorCode: "USER_INTERRUPTED",
};
const interruptedReplay = await reconciledRuntime.admit(envelope);
assert.equal(interruptedReplay.state, "terminal");
assert.equal(interruptedReplay.terminalType, "interrupted");
assert.equal(interruptedReplay.terminalError, "USER_INTERRUPTED");

durableTurn = {
  ...durableTurn,
  status: "outcome_unknown",
  outcomeUnknown: true,
  terminalAt: null,
  terminalType: null,
  errorCode: null,
};
const restoredExisting = reconciledRuntime.restoreRecovered("session_1", {
  id: "queue_reconcile",
  admittedTurnInput: durableTurn,
  options: {
    externalCommand: durableLedger.get("session_1").get("command_1"),
  },
});
assert.equal(restoredExisting, true, "restore must reconcile an existing command ledger entry");
assert.equal(
  reconciledRuntime.ledgers.get("session_1").get("command_1").state,
  "dispatch_unknown",
);

// The device triple is a process-global O(1) idempotency key. Loading more
// than the durable cap must also bound the live primary ledgers and secondary
// index. Replays may not scan every session, and terminal reconciliation must
// update both indexes synchronously.
{
  const loadedLedgers = new Map();
  for (let index = 0; index < 10_000; index += 1) {
    const sessionId = `scale_session_${index % 20}`;
    const commandId = `scale_command_${index}`;
    const record = {
      schemaVersion: 1,
      lilySessionId: sessionId,
      commandId,
      idempotencyKey: `scale_key_${index}`,
      correlationId: commandId,
      payloadHash: `scale_hash_${index}`,
      desktopDeviceId: "scale_desktop",
      mobileDeviceId: "scale_mobile",
      requestedMode: "queue",
      effectiveMode: "queue",
      downgradeReason: null,
      state: "admitted",
      queueItemId: `scale_queue_${index}`,
      turnId: `scale_turn_${index}`,
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      updatedAt: new Date(1_700_000_000_000 + index).toISOString(),
      retainUntil: new Date(1_900_000_000_000).toISOString(),
    };
    const ledger = loadedLedgers.get(sessionId) || new Map();
    ledger.set(commandId, record);
    loadedLedgers.set(sessionId, ledger);
  }
  const scaleRuntime = createExternalCommandRuntime({
    ledgerStore: {
      loadSync: () => loadedLedgers,
      flushSync: () => true,
      scheduleFlush: () => {},
    },
    findSession: (sessionId) => ({ id: sessionId }),
    getState: () => ({ queue: [] }),
  });
  const liveRecordCount = [...scaleRuntime.ledgers.values()].reduce(
    (total, ledger) => total + ledger.size,
    0,
  );
  assert.equal(liveRecordCount, 5_000, "live mobile ledgers obey the same 5000-record cap");
  assert.equal(scaleRuntime.identityIndex.size, 5_000, "the O(1) triple index is bounded with the ledgers");

  const retainedEnvelope = {
    commandId: "different_command_id_is_ignored",
    idempotencyKey: "scale_key_9999",
    payloadHash: "scale_hash_9999",
    lilySessionId: "different_target_session",
    desktopDeviceId: "scale_desktop",
    mobileDeviceId: "scale_mobile",
    text: "global tuple replay",
    mode: "queue",
  };
  const originalValues = scaleRuntime.ledgers.values;
  scaleRuntime.ledgers.values = () => {
    throw new Error("global ledger scan is forbidden");
  };
  try {
    for (let index = 0; index < 10_000; index += 1) {
      const hit = await scaleRuntime.admit(retainedEnvelope);
      assert.equal(hit.ok, true);
      assert.equal(hit.commandId, "scale_command_9999");
      assert.equal(hit.turnId, "scale_turn_9999");
    }
  } finally {
    scaleRuntime.ledgers.values = originalValues;
  }

  const terminalUpdated = scaleRuntime.reconcileTurnInput({
    sessionId: "scale_session_19",
    turnId: "scale_turn_9999",
    status: "completed",
    terminalType: "turn.completed",
    terminalAt: 1_800_000_000_000,
    externalCommandId: "scale_command_9999",
    externalIdempotencyKey: "scale_key_9999",
    externalPayloadHash: "scale_hash_9999",
    externalDesktopDeviceId: "scale_desktop",
    externalMobileDeviceId: "scale_mobile",
  });
  assert.equal(terminalUpdated, true);
  assert.equal(
    scaleRuntime.identityIndex.get(
      "scale_desktop\u0000scale_mobile\u0000scale_key_9999",
    )?.record?.state,
    "terminal",
    "terminal projection updates the indexed ledger entry synchronously",
  );
}

console.log("external-command-runtime: ok");
