#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createAttachmentSendCoordinator } = require("../src/main/collaboration/attachment-send.js");
const { createTransferRuntime } = require("../src/main/collaboration/transfer-runtime.js");
const { createTransferManifestStore } = require("../src/main/collaboration/transfer-manifest.js");
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");

const intents = new Map();
let persisted = 0;
let submitted = 0;
const store = {
  getConversation({ conversationId }) { return conversationId === "c1" ? { id: "c1", scopeId: "team:design" } : null; },
  getOutbox({ outboxId }) { return intents.get(`outbox:${outboxId}`) || null; },
  persistDraftAndOptimisticMessage(input) {
    persisted += 1;
    intents.set(`outbox:${input.clientCommandId}`, { ...input, id: input.clientCommandId, state: "queued" });
    return { outboxId: input.clientCommandId };
  },
};
const transfers = {
  createSendIntent({ conversationId, transferIds, bodyText, clientCommandId }) {
    const prior = intents.get("intent");
    const next = prior || { conversationId, scopeId: "team:design", purpose: "attachment", transferIds, bodyText, clientCommandId: clientCommandId || "stable-send-id", attachmentIds: ["object-a", "object-b"], state: "waiting_attachments" };
    if (prior) assert.deepEqual({ conversationId, transferIds, bodyText, clientCommandId: clientCommandId || prior.clientCommandId }, { conversationId: prior.conversationId, transferIds: prior.transferIds, bodyText: prior.bodyText, clientCommandId: prior.clientCommandId }, "same send identity may only replay immutable intent");
    intents.set("intent", next); return next;
  },
  listSendIntents() { return [...intents.values()].filter((item) => item?.state === "ready_to_handoff"); },
  handoffIntent(intent) { return intent.state === "ready_to_handoff" ? { ...intent, state: "ready_to_handoff" } : intent; },
};
const outbox = { async submit(id) { submitted += 1; return { state: "confirming", clientCommandId: id }; } };
const coordinator = createAttachmentSendCoordinator({ store, transfers, outbox, assertActive() {} });

const waiting = await coordinator.sendAttachments({ conversationId: "c1", transferIds: ["t-a", "t-b"], bodyText: "work", clientCommandId: "stable-send-id" });
assert.deepEqual(waiting, { ok: true, state: "waiting_attachments", clientCommandId: "stable-send-id" });
assert.equal(persisted, 0, "explicit attachment send persists intent only; preparing/uploading is not text outbox work");

intents.set("intent", { ...intents.get("intent"), state: "ready_to_handoff" });
assert.deepEqual(await coordinator.recover(), { handedOff: 1 });
assert.equal(persisted, 1); assert.equal(submitted, 1);
const row = store.getOutbox({ outboxId: "stable-send-id" });
assert.deepEqual({ bodyText: row.bodyText, attachmentIds: row.attachmentIds, attachmentPurpose: row.attachmentPurpose }, { bodyText: "work", attachmentIds: ["object-a", "object-b"], attachmentPurpose: "attachment" }, "verified attachment references enter the existing text outbox exactly once");
assert.deepEqual(await coordinator.recover(), { handedOff: 0 });
assert.equal(persisted, 1); assert.equal(submitted, 1, "restart/replay never creates a second text outbox item");

let healthyWrites = 0;
const isolatedRecovery = createAttachmentSendCoordinator({
  store: {
    getOutbox() { return null; },
    persistDraftAndOptimisticMessage({ clientCommandId }) { healthyWrites += 1; return { outboxId: clientCommandId }; },
  },
  transfers: {
    listSendIntents() { return [
      { clientCommandId: "bad-device", conversationId: "c1", scopeId: "personal", purpose: "attachment", transferIds: ["bad"], bodyText: "bad" },
      { clientCommandId: "healthy-device", conversationId: "c2", scopeId: "personal", purpose: "attachment", transferIds: ["good"], bodyText: "good" },
    ]; },
    async handoffIntent(intent) {
      if (intent.clientCommandId === "bad-device") throw Object.assign(new Error("device changed"), { code: "COLLAB_TRANSFER_DEVICE_CHANGED" });
      return { ...intent, attachmentIds: ["object-good"], state: "ready_to_handoff" };
    },
  },
  outbox: { async submit(id) { return { state: "confirming", clientCommandId: id }; } },
});
assert.deepEqual(await isolatedRecovery.recover(), { handedOff: 1, failures: [{ clientCommandId: "bad-device", code: "COLLAB_TRANSFER_DEVICE_CHANGED" }] }, "one broken recovery intent is reported without preventing an unrelated healthy attachment handoff");
assert.equal(healthyWrites, 1);

// The journal test uses the real encrypted manifests and SQLite cache. It
// proves the waiting intent survives process restart and that two attachments
// are claimed as one immutable send rather than becoming a second queue.
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-attachment-send-")));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() };
const keyPath = path.join(dir, "keyring.json");
const sourcePath = path.join(dir, "brief.txt");
fs.writeFileSync(sourcePath, "brief", "utf8");
const storePath = path.join(dir, "collaboration.db");
const keyring = new LocalCollaborationKeyring({ filePath: keyPath, safeStorage });
const durableStore = new CollaborationStore({ dbPath: storePath, accountId: "alice", keyring });
durableStore.replaceProjectionFromBootstrap({ conversations: [{ id: "conversation", kind: "direct" }] });
const runtimeOptions = {
  store: durableStore, client: { objects: {} }, deviceId: "device", policy: { enabled: true, attachments: true },
  rootPath: path.join(dir, "collaboration-transfer"), chooseFile: async () => ({ canceled: false, filePaths: [sourcePath] }), assertActive() {},
};
const runtime = createTransferRuntime(runtimeOptions);
assert.equal(runtime.ok, true);
const first = await runtime.prepareAttachment({ conversationId: "conversation" });
const second = await runtime.prepareAttachment({ conversationId: "conversation" });
assert.equal((await runtime.pause({ transferId: first.id })).state, "paused");
const durableIntent = runtime.createSendIntent({ conversationId: "conversation", transferIds: [first.id, second.id], bodyText: "durable attachment" });
assert.equal(durableStore.listOutbox().length, 0, "waiting transfer intent never occupies the text outbox lane");
const waitingTransfer = runtime.list().transfers.find((item) => item.id === first.id);
assert.equal(waitingTransfer.state, "paused", "explicit send never restarts an upload the user paused");
assert.deepEqual({ sendState: waitingTransfer.sendState, clientCommandId: waitingTransfer.clientCommandId }, { sendState: "waiting_attachments", clientCommandId: durableIntent.clientCommandId }, "transfer list derives a safe message waiting projection without changing transfer state");
assert.equal(runtime.list().transfers.find((item) => item.id === second.id).automaticRetry, true, "explicit send schedules a fresh prepared upload after its intent is durable");
assert.throws(() => runtime.createSendIntent({ conversationId: "conversation", transferIds: [first.id], bodyText: "other message" }), (error) => error?.code === "COLLAB_ATTACHMENT_ALREADY_CLAIMED", "a claimed attachment cannot be bound to another send intent");
const manifests = createTransferManifestStore({ rootPath: runtimeOptions.rootPath, accountId: "alice", keyring });
const secondBeforeCrash = manifests.read(second.id);
const { schedule: droppedSchedule, ...checkpointWithoutSchedule } = secondBeforeCrash.checkpoint;
manifests.update({ id: second.id, expectedRevision: secondBeforeCrash.revision, checkpoint: checkpointWithoutSchedule });
runtime.stop(); durableStore.close();

const restartedKeyring = new LocalCollaborationKeyring({ filePath: keyPath, safeStorage });
const restartedStore = new CollaborationStore({ dbPath: storePath, accountId: "alice", keyring: restartedKeyring });
const restarted = createTransferRuntime({ ...runtimeOptions, store: restartedStore });
const restartedIntents = restarted.listSendIntents();
assert.equal(restartedIntents.length, 1, "restart discovers exactly one durable attachment send intent");
assert.equal(restartedIntents[0].clientCommandId, durableIntent.clientCommandId, "restart retains the original idempotency key");
assert.equal(restarted.list().transfers.find((item) => item.id === second.id).automaticRetry, true, "restart repairs the initial prepared-upload schedule that was not yet durably enabled before a crash");
restartedStore.saveDraft({ conversationId: "conversation", text: "durable attachment" });
const restartedManifests = createTransferManifestStore({ rootPath: runtimeOptions.rootPath, accountId: "alice", keyring: restartedKeyring });
for (const [index, id] of [first.id, second.id].entries()) {
  const item = restartedManifests.read(id);
  restartedManifests.update({ id, expectedRevision: item.revision, checkpoint: { ...item.checkpoint, state: "verified", objectId: `object-${index}`, deviceId: "device" } });
}
let durableSubmits = 0;
const durableCoordinator = createAttachmentSendCoordinator({
  store: restartedStore, transfers: restarted,
  outbox: { async submit(id) { durableSubmits += 1; return { state: "confirming", clientCommandId: id }; } },
});
await Promise.all([durableCoordinator.recover(), durableCoordinator.recover()]);
assert.equal(restartedStore.listOutbox().length, 1, "concurrent recovery writes the existing text outbox exactly once");
assert.equal(durableSubmits, 1, "the existing text outbox performs the sole submit path once");
assert.equal(restartedStore.getDraft({ conversationId: "conversation", draftId: "composer" }).text, "durable attachment",
  "attachment handoff preserves a newly typed composer draft even when its text equals the original attachment caption");
const durableOutbox = restartedStore.getOutbox({ outboxId: durableIntent.clientCommandId });
assert.deepEqual(durableOutbox.attachmentIds, ["object-0", "object-1"], "only verified server object references enter the durable text command");
assert.equal(restarted.listSendIntents().length, 0, "post-handoff recovery has no second attachment dispatch queue");
const admittedTransfer = restarted.list().transfers.find((item) => item.id === first.id);
assert.deepEqual({ sendState: admittedTransfer.sendState, clientCommandId: admittedTransfer.clientCommandId }, { sendState: "queued", clientCommandId: durableIntent.clientCommandId }, "transfer list projects existing outbox state separately from verified transfer state");
assert.equal((await restarted.cancel({ transferId: first.id })).code, "COLLAB_MESSAGE_CANCELLATION_REQUIRED", "an admitted attachment must use the message cancellation flow");
const cancelledFirst = await restarted.prepareAttachment({ conversationId: "conversation" });
const cancelledSecond = await restarted.prepareAttachment({ conversationId: "conversation" });
const cancelledIntent = restarted.createSendIntent({ conversationId: "conversation", transferIds: [cancelledFirst.id, cancelledSecond.id], bodyText: "cancel crash" });
const cancelledCoordinator = restartedManifests.read(cancelledFirst.id);
restartedManifests.update({ id: cancelledFirst.id, expectedRevision: cancelledCoordinator.revision, checkpoint: { ...cancelledCoordinator.checkpoint,
  sendIntent: { ...cancelledCoordinator.checkpoint.sendIntent, status: "cancelled" } } });
// Simulate a process crash precisely after the authoritative coordinator write and
// before any child schedule cleanup. Their old enabled schedule must be inert.
restarted.stop(); restartedStore.close();
let cancelledNetworkCalls = 0;
const cancelledKeyring = new LocalCollaborationKeyring({ filePath: keyPath, safeStorage });
const cancelledStore = new CollaborationStore({ dbPath: storePath, accountId: "alice", keyring: cancelledKeyring });
const cancelledRuntime = createTransferRuntime({ ...runtimeOptions, store: cancelledStore, client: { objects: { async status() { cancelledNetworkCalls += 1; return null; } } } });
cancelledRuntime.start(); await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve));
assert.equal(cancelledNetworkCalls, 0, "a crash after coordinator cancellation cannot resume any linked child upload on restart");
assert.throws(() => cancelledRuntime.handoffIntent(cancelledIntent), (error) => error?.code === "COLLAB_ATTACHMENT_CANCELLED", "cancelled coordinator cannot ever hand off verified files into outbox");
const exhausted = await cancelledRuntime.prepareAttachment({ conversationId: "conversation" });
cancelledRuntime.createSendIntent({ conversationId: "conversation", transferIds: [exhausted.id], bodyText: "retry-budget" });
const exhaustedManifests = createTransferManifestStore({ rootPath: runtimeOptions.rootPath, accountId: "alice", keyring: cancelledKeyring });
const exhaustedItem = exhaustedManifests.read(exhausted.id);
exhaustedManifests.update({ id: exhausted.id, expectedRevision: exhaustedItem.revision, checkpoint: { ...exhaustedItem.checkpoint,
  schedule: { enabled: false, attempts: 3, nextAttemptAt: 0, code: "COLLAB_TRANSFER_RETRY_LIMIT" } } });
cancelledRuntime.listSendIntents();
assert.deepEqual(exhaustedManifests.read(exhausted.id).checkpoint.schedule, { enabled: false, attempts: 3, nextAttemptAt: 0, code: "COLLAB_TRANSFER_RETRY_LIMIT" }, "recovery fills only a missing initial schedule and never resets an exhausted retry budget");
const missingCoordinator = await cancelledRuntime.prepareAttachment({ conversationId: "conversation" });
const missingChild = await cancelledRuntime.prepareAttachment({ conversationId: "conversation" });
cancelledRuntime.createSendIntent({ conversationId: "conversation", transferIds: [missingCoordinator.id, missingChild.id], bodyText: "missing child" });
// Simulate a crash followed by an externally missing linked manifest.  The
// surviving encrypted coordinator is still authoritative, so recovery must
// fail loud on the next process rather than silently leave the message waiting.
fs.rmSync(createTransferManifestStore({ rootPath: runtimeOptions.rootPath, accountId: "alice", keyring: cancelledKeyring }).directory(missingChild.id), { recursive: true, force: true });
cancelledRuntime.stop(); cancelledStore.close();
const reopenedKeyring = new LocalCollaborationKeyring({ filePath: keyPath, safeStorage });
const reopenedStore = new CollaborationStore({ dbPath: storePath, accountId: "alice", keyring: reopenedKeyring });
const reopenedRuntime = createTransferRuntime({ ...runtimeOptions, store: reopenedStore });
const reopenedView = reopenedRuntime.list();
assert.equal(reopenedView.recoveryFailureCount, 1, "a reopened coordinator with a missing linked manifest is surfaced as one safe recovery failure");
assert.equal(reopenedView.unrecognizedCount, 0, "a missing linked child is distinct from an unrecognized on-disk manifest");
const corruptedCoordinator = await reopenedRuntime.prepareAttachment({ conversationId: "conversation" });
const claimedChild = await reopenedRuntime.prepareAttachment({ conversationId: "conversation" });
reopenedRuntime.createSendIntent({ conversationId: "conversation", transferIds: [corruptedCoordinator.id, claimedChild.id], bodyText: "corrupt claim" });
const corruptedManifests = createTransferManifestStore({ rootPath: runtimeOptions.rootPath, accountId: "alice", keyring: reopenedKeyring });
fs.writeFileSync(path.join(corruptedManifests.directory(corruptedCoordinator.id), "manifest.json"), "corrupt", "utf8");
assert.throws(() => reopenedRuntime.createSendIntent({ conversationId: "conversation", transferIds: [claimedChild.id], bodyText: "attempt reassignment" }),
  (error) => error?.code === "COLLAB_ATTACHMENT_INTENT_UNAVAILABLE", "an unauthenticated coordinator manifest fails closed rather than freeing a claimed attachment");
reopenedRuntime.stop(); reopenedStore.close(); fs.rmSync(dir, { recursive: true, force: true });

let active = true, releaseVerification;
let fencedWrites = 0;
const fenced = createAttachmentSendCoordinator({
  store: { getOutbox() { return null; }, persistDraftAndOptimisticMessage() { fencedWrites += 1; return { outboxId: "fenced-command" }; } },
  transfers: {
    createSendIntent() { return { coordinatorId: "transfer-a", clientCommandId: "fenced-command", conversationId: "c1", scopeId: "personal", purpose: "attachment", transferIds: ["transfer-a"], bodyText: "fenced", state: "ready_to_handoff" }; },
    handoffIntent(intent) { return new Promise((resolve) => { releaseVerification = () => resolve({ ...intent, attachmentIds: ["object-a"], state: "ready_to_handoff" }); }); },
  },
  outbox: { async submit() { throw new Error("must not submit after stop"); } },
  assertActive() { if (!active) throw Object.assign(new Error("stopped"), { code: "COLLABORATION_STOPPED" }); },
});
const fencedSend = fenced.sendAttachments({ conversationId: "c1", transferIds: ["transfer-a"], bodyText: "fenced", clientCommandId: "fenced-command" });
await Promise.resolve();
active = false; releaseVerification();
await assert.rejects(fencedSend, (error) => error?.code === "COLLABORATION_STOPPED", "a late verification callback is fenced before it can write the text outbox");
assert.equal(fencedWrites, 0, "stopped/revoked account cannot persist an attachment message after awaited verification");

console.log("collaboration attachment send: ok");
