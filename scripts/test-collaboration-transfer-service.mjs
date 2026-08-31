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
function fixture(t, overrides = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "collab-transfer-service-")));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys"), safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() } });
  const store = new CollaborationStore({ dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring });
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "conversation", kind: "direct" }] });
  const filename = path.join(dir, "result.txt"); fs.writeFileSync(filename, "result");
  const service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device", realtimeEnabled: false,
    client: { objects: {} }, policy: { enabled: true, attachments: true },
    transferOptions: { rootPath: path.join(dir, "collaboration-transfer"), chooseFile: async () => ({ canceled: false, filePaths: [filename] }), ...overrides } });
  t.after(() => { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, service };
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
