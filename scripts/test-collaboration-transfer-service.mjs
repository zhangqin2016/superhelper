import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { createCollaborationService } = require("../src/main/collaboration/service");
const { createCollaborationIpc } = require("../src/main/ipc-collaboration");
const { createTransferManifestStore } = require("../src/main/collaboration/transfer-manifest");
function fixture(t, overrides = {}) {
  const { transport, client = { objects: {} }, deviceId = "device", ...transferOverrides } = overrides;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "collab-transfer-service-")));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys"), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
  const store = new CollaborationStore({ dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring });
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "conversation", kind: "direct" }] });
  const filename = path.join(dir, "result.txt"); fs.writeFileSync(filename, "result");
  const service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId, realtimeEnabled: false,
    client, policy: { enabled: true, attachments: true }, transport,
    transferOptions: { rootPath: path.join(dir, "collaboration-transfer"), chooseFile: async () => ({ canceled: false, filePaths: [filename] }), ...transferOverrides } });
  t.after(() => { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, service, store, keyring };
}
test("service and closed IPC expose a native attachment flow, never raw paths or keys", async (t) => {
  const f = fixture(t);
  assert.equal(typeof f.service.prepareAttachment, "function", "transfer runtime must be assembled into the account-scoped service");
  const handlers = new Map();
  createCollaborationIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getService: () => f.service });
  assert.equal(typeof handlers.get("collaboration:prepare-attachment"), "function");
  assert.equal((await handlers.get("collaboration:prepare-attachment")(null, { conversationId: "conversation", inputPath: "/secret" })).code, "COLLABORATION_INVALID_INPUT");
  const item = await handlers.get("collaboration:prepare-attachment")(null, { conversationId: "conversation" });
  assert.equal(item.state, "prepared"); assert.equal(item.originalName, "result.txt");
  const view = await handlers.get("collaboration:get-transfers")(null);
  assert.equal(view.transfers[0].id, item.id);
  assert.ok(!JSON.stringify(view).includes(f.dir)); assert.doesNotMatch(JSON.stringify(view), /dek|ciphertextSha256/);
  assert.equal((await handlers.get("collaboration:pause-transfer")(null, { transferId: item.id })).state, "paused");
  assert.equal((await handlers.get("collaboration:cancel-transfer")(null, { transferId: item.id })).state, "cancelled");
  f.service.stop();
  assert.equal((await handlers.get("collaboration:get-transfers")(null)).ok, false);
});
test("explicit attachment send creates only a durable waiting intent and derives its stable safe view", async (t) => {
  const f = fixture(t, { transport: { submit: async () => ({ ok: true }), lookupReceipt: async () => null } });
  const prepared = await f.service.prepareAttachment({ conversationId: "conversation" });
  const waiting = await f.service.sendAttachments({ conversationId: "conversation", transferIds: [prepared.id], bodyText: "send when verified" });
  assert.deepEqual({ ok: waiting.ok, state: waiting.state }, { ok: true, state: "waiting_attachments" });
  assert.match(waiting.clientCommandId, /^[a-f0-9-]{36}$/i, "the stable command ID is main-process derived from the transfer journal");
  assert.equal(f.service.store.listOutbox().length, 0, "waiting uploads do not occupy the ordinary text outbox lane");
  const transfer = f.service.getTransfers().transfers.find((item) => item.id === prepared.id);
  assert.deepEqual({ sendState: transfer.sendState, clientCommandId: transfer.clientCommandId }, { sendState: "waiting_attachments", clientCommandId: waiting.clientCommandId });
  assert.deepEqual(await f.service.sendAttachments({ conversationId: "conversation", transferIds: [prepared.id], bodyText: "send when verified", clientCommandId: waiting.clientCommandId }), waiting, "the stable command can be replayed without a second intent");
});
test("already verified attachments hand off immediately into the ordinary outbox", async (t) => {
  let submitCount = 0;
  const f = fixture(t, { transport: { async submit() { submitCount += 1; }, async lookupReceipt() { return null; } } });
  const first = await f.service.prepareAttachment({ conversationId: "conversation" });
  const second = await f.service.prepareAttachment({ conversationId: "conversation" });
  const manifests = createTransferManifestStore({ rootPath: path.join(f.dir, "collaboration-transfer"), accountId: "alice", keyring: f.keyring });
  for (const [index, id] of [first.id, second.id].entries()) {
    const item = manifests.read(id);
    manifests.update({ id, expectedRevision: item.revision, checkpoint: { ...item.checkpoint, state: "verified", objectId: `object-${index}`, deviceId: "device" } });
  }
  const result = await f.service.sendAttachments({ conversationId: "conversation", transferIds: [first.id, second.id], bodyText: "verified before send" });
  assert.equal(result.state, "confirming", "explicit send must not wait for a future transfer callback when all objects are already verified");
  assert.equal(submitCount, 1);
  assert.deepEqual(f.store.getOutbox({ outboxId: result.clientCommandId }).attachmentIds, ["object-0", "object-1"]);
});
test("replacement device never replays or queries receipt for an admitted attachment outbox command", async (t) => {
  const f = fixture(t, { transport: { async submit() {}, async lookupReceipt() { return null; } } });
  const prepared = await f.service.prepareAttachment({ conversationId: "conversation" });
  const manifests = createTransferManifestStore({ rootPath: path.join(f.dir, "collaboration-transfer"), accountId: "alice", keyring: f.keyring });
  const item = manifests.read(prepared.id);
  manifests.update({ id: prepared.id, expectedRevision: item.revision, checkpoint: { ...item.checkpoint, state: "verified", objectId: "object-device-fence", deviceId: "device" } });
  const admitted = await f.service.sendAttachments({ conversationId: "conversation", transferIds: [prepared.id], bodyText: "device-fenced attachment" });
  assert.equal(f.store.getOutbox({ outboxId: admitted.clientCommandId }).originDeviceId, "device", "handoff persists the original device identity inside encrypted outbox payload");
  f.service.stop();
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() };
  const replacementKeyring = new LocalCollaborationKeyring({ filePath: path.join(f.dir, "keys"), safeStorage });
  const replacementStore = new CollaborationStore({ dbPath: path.join(f.dir, "cache.db"), accountId: "alice", keyring: replacementKeyring });
  let submitCalls = 0, receiptCalls = 0;
  const replacement = createCollaborationService({
    openStore: () => ({ ok: true, store: replacementStore }), deviceId: "device-replacement", realtimeEnabled: false,
    client: { objects: {} }, policy: { enabled: true, attachments: true },
    transport: { async submit() { submitCalls += 1; }, async lookupReceipt() { receiptCalls += 1; return null; } },
    transferOptions: { rootPath: path.join(f.dir, "collaboration-transfer"), chooseFile: async () => ({ canceled: true }) },
  });
  replacement.start(); await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(submitCalls, 0); assert.equal(receiptCalls, 0, "new device cannot use its own signature/receipt partition to recover an old attachment command");
  assert.equal(replacement.store.getOutbox({ outboxId: admitted.clientCommandId }).state, "confirming", "identity mismatch retains durable delivery uncertainty rather than rewriting the command");
  replacement.stop();
});
test("transfer root failure leaves text collaboration enabled", (t) => {
  const f = fixture(t, { rootPath: "/not-an-authorized-transfer-root" });
  assert.equal(f.service.ok, true);
  assert.equal(typeof f.service.getTransfers, "function");
  assert.equal(f.service.getTransfers().ok, false);
  assert.equal(f.service.list().conversations.length, 1);
  assert.equal(f.service.saveDraft({ conversationId: "conversation", text: "ordinary text" }).ok, true);
});
test("late native dialog completion after service replacement cannot publish prior account data", async (t) => {
  let release;
  const f = fixture(t, { chooseFile: () => new Promise((resolve) => { release = resolve; }) });
  assert.equal(typeof f.service.prepareAttachment, "function");
  let current = f.service;
  const handlers = new Map(); createCollaborationIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getService: () => current });
  const pending = handlers.get("collaboration:prepare-attachment")(null, { conversationId: "conversation" });
  f.service.stop(); current = { ok: true };
  release({ canceled: false, filePaths: [path.join(f.dir, "result.txt")] });
  const result = await pending;
  assert.equal(result.code, "COLLAB_ACCOUNT_CHANGED"); assert.ok(!JSON.stringify(result).includes(f.dir));
});
