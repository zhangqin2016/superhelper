#!/usr/bin/env node
// This is a failure-injection contract for the only durable collaboration
// commit point. The fake transaction restores all writes on any pre-commit
// failure, so the assertions mirror PostgreSQL atomicity rather than mocks.

import assert from "node:assert/strict";

const {
  runCollaborationCommand,
} = await import("../server/src/services/collaboration/command-runner.js");

function cloneReceipt(receipt) {
  return receipt && { ...receipt, responsePayload: structuredClone(receipt.responsePayload) };
}

function createHarness() {
  const state = {
    receipts: new Map(),
    events: [],
    projections: [],
    sync: [],
    outbox: [],
    nextSeq: 1,
  };
  const steps = [];
  const snapshot = () => ({
    receipts: new Map([...state.receipts].map(([key, value]) => [key, cloneReceipt(value)])),
    events: structuredClone(state.events),
    projections: structuredClone(state.projections),
    sync: structuredClone(state.sync),
    outbox: structuredClone(state.outbox),
    nextSeq: state.nextSeq,
  });
  const restore = (saved) => Object.assign(state, saved);
  const keyOf = (identity) => `${identity.actorDeviceId}:${identity.commandType}:${identity.clientCommandId}`;

  const database = {
    transaction() {
      return {
        async execute(callback) {
          const saved = snapshot();
          try {
            const result = await callback({});
            steps.push("commit");
            return result;
          } catch (error) {
            restore(saved);
            steps.push("rollback");
            throw error;
          }
        },
      };
    },
  };
  const operations = {
    async findReceipt(_trx, identity) {
      return cloneReceipt(state.receipts.get(keyOf(identity)) || null);
    },
    async claimReceipt(_trx, identity, requestFingerprint) {
      const key = keyOf(identity);
      const existing = state.receipts.get(key);
      if (existing) return { inserted: false, receipt: cloneReceipt(existing) };
      const receipt = { ...identity, requestFingerprint, state: "running", responsePayload: {} };
      state.receipts.set(key, receipt);
      return { inserted: true, receipt: cloneReceipt(receipt) };
    },
    async allocateSequence() {
      steps.push("sequence");
      return { conversation: { id: "conv-1" }, seq: state.nextSeq++ };
    },
    async allocateRelationshipSequence() {
      steps.push("relationship-sequence");
      return { conversation: null, seq: state.nextSeq++ };
    },
    async writeEvent(_trx, event) {
      steps.push("event");
      state.events.push(structuredClone(event));
      return event;
    },
    async fanout(_trx, { event, recipientUserIds }) {
      steps.push("sync");
      const rows = recipientUserIds.map((userId, index) => ({ userId, cursor: index + 1, eventId: event.id }));
      state.sync.push(...rows);
      return rows;
    },
    async completeReceipt(_trx, identity, completed) {
      steps.push("receipt");
      state.receipts.set(keyOf(identity), { ...state.receipts.get(keyOf(identity)), ...completed, state: "completed" });
    },
    async writeRealtimeOutbox(_trx, rows) {
      steps.push("outbox");
      state.outbox.push(...structuredClone(rows));
    },
  };
  return { state, steps, database, operations };
}

{
  const harness = createHarness();
  const relationship = command({ harness });
  relationship.commandType = "friend.request";
  relationship.clientCommandId = "relationship-1";
  relationship.input = { lilyId: "lily-b" };
  relationship.project = async () => ({
    event: { id: "evt-relationship-1", conversationId: null, type: "friend.requested", payload: { peerUserId: "user-b" } },
    recipientUserIds: ["user-a", "user-b"],
    project: async () => { harness.steps.push("projection"); },
  });
  const response = await runCollaborationCommand(relationship);
  assert.equal(response.eventId, "evt-relationship-1");
  assert.deepEqual(harness.steps, ["authorize", "relationship-sequence", "event", "projection", "sync", "receipt", "outbox", "commit"], "relationship events remain immutable, cursor-fanned and outboxed without inventing a direct conversation");
  assert.equal(harness.state.events[0].conversationId, null);
}

function command(overrides = {}) {
  return {
    account: { userId: "user-a", deviceId: "device-a" },
    commandType: "message.create",
    clientCommandId: "command-1",
    input: { conversationId: "conv-1", bodyCiphertext: "ciphertext-a", attachmentIds: ["obj-b", "obj-a"] },
    authorize: async () => {
      overrides.harness.steps.push("authorize");
      return { ok: true };
    },
    project: async () => ({
      event: { id: "evt-1", conversationId: "conv-1", type: "message.created", payload: { messageId: "msg-1" } },
      recipientUserIds: ["user-a", "user-b"],
      project: async () => {
        overrides.harness.steps.push("projection");
        if (overrides.failProjection) throw new Error("projection write failed");
        overrides.harness.state.projections.push({ id: "msg-1" });
      },
      response: {
        eventId: "evt-1",
        message: { id: "msg-1", conversationId: "conv-1", seq: 1 },
        signedUrl: "https://must-not-enter-receipt.example",
        localPath: "/private/local-only",
      },
    }),
    database: overrides.harness.database,
    operations: overrides.harness.operations,
    maxTransactionRetries: overrides.maxTransactionRetries,
    afterCommit: overrides.afterCommit,
  };
}

{
  const harness = createHarness();
  const first = await runCollaborationCommand(command({ harness }));
  assert.deepEqual(
    harness.steps,
    ["authorize", "sequence", "event", "projection", "sync", "receipt", "outbox", "commit"],
    "the single transaction follows authorization -> sequence -> event/projection -> sync -> receipt -> outbox -> commit",
  );
  assert.equal(first.eventId, "evt-1");
  assert.equal(first.responseCode, "OK", "the original durable response code is returned to callers");
  assert.equal(harness.state.events.length, 1);
  assert.equal(harness.state.projections.length, 1);
  assert.equal(harness.state.sync.length, 2);
  assert.equal(harness.state.outbox.length, 2);
  assert.deepEqual(
    harness.state.receipts.get("device-a:message.create:command-1").responsePayload,
    { eventId: "evt-1", message: { id: "msg-1", conversationId: "conv-1", seq: 1 } },
    "receipt stores only replay-safe identifiers and view data",
  );

  harness.steps.length = 0;
  const replay = await runCollaborationCommand(command({ harness }));
  assert.deepEqual(replay, first, "same command key and body replay the original result");
  assert.equal(replay.responseCode, "OK", "a replay preserves the original response code");
  assert.deepEqual(harness.steps, ["authorize", "commit"], "a replay rechecks authorization but does not write a second event or projection");

  const revokedReplay = command({ harness });
  revokedReplay.authorize = async () => ({ ok: false, code: "COLLAB_MEMBERSHIP_INACTIVE", auditReason: "revoked" });
  await assert.rejects(
    runCollaborationCommand(revokedReplay),
    (error) => error?.code === "COLLAB_MEMBERSHIP_INACTIVE",
    "a receipt replay must not bypass newly revoked authorization",
  );

  await assert.rejects(
    runCollaborationCommand({ ...command({ harness }), input: { conversationId: "conv-1", bodyCiphertext: "different" } }),
    (error) => error?.code === "IDEMPOTENCY_KEY_REUSED",
  );
  assert.equal(harness.state.events.length, 1, "changed input cannot create another event under the old command id");
}

{
  const harness = createHarness();
  await assert.rejects(runCollaborationCommand(command({ harness, failProjection: true })), /projection write failed/);
  assert.equal(harness.state.receipts.size, 0, "projection failure rolls receipt back");
  assert.equal(harness.state.events.length, 0, "projection failure rolls event back");
  assert.equal(harness.state.sync.length, 0, "projection failure rolls sync fanout back");
  assert.equal(harness.state.outbox.length, 0, "projection failure rolls realtime outbox back");
}

{
  const harness = createHarness();
  await assert.rejects(
    runCollaborationCommand(command({ harness, afterCommit: async () => { throw new Error("response lost after commit"); } })),
    /response lost after commit/,
  );
  assert.equal(harness.state.events.length, 1, "an ACK loss happens after the durable commit");
  const retry = await runCollaborationCommand(command({ harness }));
  assert.equal(retry.eventId, "evt-1");
  assert.equal(harness.state.events.length, 1, "retry after ACK loss returns the original event, not a duplicate");
}

{
  const harness = createHarness();
  let attempts = 0;
  const retrying = command({ harness, maxTransactionRetries: 1 });
  retrying.authorize = async () => {
    harness.steps.push("authorize");
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("serialization failure");
      error.code = "40001";
      throw error;
    }
    return { ok: true };
  };
  await runCollaborationCommand(retrying);
  assert.equal(attempts, 2, "a retryable database failure reuses the same command exactly once");
  assert.equal(harness.state.events.length, 1);
}

{
  const harness = createHarness();
  const malicious = command({ harness });
  malicious.authorize = async ({ input }) => {
    harness.steps.push(`authorize:${input.conversationId}`);
    return input.conversationId === "conv-1"
      ? { ok: true }
      : { ok: false, code: "COLLAB_MEMBERSHIP_INACTIVE", auditReason: "resolved-conversation-denied" };
  };
  malicious.resolveInput = ({ input }) => ({ ...input, conversationId: "conv-evil" });
  await assert.rejects(
    runCollaborationCommand(malicious),
    (error) => error?.code === "COLLAB_MEMBERSHIP_INACTIVE",
    "the final resolved command input must be authorized inside the same transaction",
  );
  assert.deepEqual(harness.steps, ["authorize:conv-1", "authorize:conv-evil", "rollback"]);
  assert.equal(harness.state.receipts.size, 0, "a resolver may not claim a receipt after final authorization rejects");
  assert.equal(harness.state.events.length, 0, "a resolver may not change an event conversation after authorization");
  assert.equal(harness.state.projections.length, 0);
}

console.log("collaboration command runner: ok");
