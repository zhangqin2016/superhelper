import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCollaborationIpc } = require("../src/main/ipc-collaboration");
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { createCollaborationService } = require("../src/main/collaboration/service");
const { removeConversationRows } = require("../src/main/collaboration/access-revocation");
const handlers = new Map();
const calls = [];
let service = {
  ok: true,
  getEditDraft: (input) => { calls.push(["get", input]); return { ok: true, conversationId: "c", messageId: "m", draft: { bodyText: "secret", baseRevision: 2, generation: 3, updatedAt: 4, accountId: "hidden" } }; },
  saveEditDraft: (input) => { calls.push(["save", input]); return { ok: true, conversationId: "c", messageId: "m", generation: 4, updatedAt: 5, path: "hidden" }; },
  clearEditDraft: (input) => { calls.push(["clear", input]); return { ok: true, conversationId: "c", messageId: "m", cleared: true, bodyText: "hidden" }; },
};
createCollaborationIpc({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, getService: () => service });

assert.deepEqual(await handlers.get("collaboration:get-edit-draft")(null, { conversationId: "c", messageId: "m" }),
  { ok: true, conversationId: "c", messageId: "m", draft: { bodyText: "secret", baseRevision: 2, generation: 3, updatedAt: 4 } });
assert.deepEqual(await handlers.get("collaboration:save-edit-draft")(null, { conversationId: "c", messageId: "m", bodyText: "changed", baseRevision: 2, expectedGeneration: 3 }),
  { ok: true, conversationId: "c", messageId: "m", generation: 4, updatedAt: 5 });
assert.deepEqual(await handlers.get("collaboration:clear-edit-draft")(null, { conversationId: "c", messageId: "m", expectedGeneration: 4 }),
  { ok: true, conversationId: "c", messageId: "m", cleared: true });
const called = calls.length;
for (const [channel, payload] of [
  ["collaboration:get-edit-draft", { conversationId: "c", messageId: "m", accountId: "alice" }],
  ["collaboration:save-edit-draft", { conversationId: "c", messageId: "m", bodyText: "x".repeat(65537), baseRevision: 2, expectedGeneration: 3 }],
  ["collaboration:save-edit-draft", { conversationId: "c", messageId: "m", bodyText: "x", baseRevision: 0, expectedGeneration: 3 }],
  ["collaboration:clear-edit-draft", { conversationId: "c", messageId: "m", expectedGeneration: -1 }],
]) assert.equal((await handlers.get(channel)(null, payload)).code, "COLLABORATION_INVALID_INPUT");
assert.equal(calls.length, called, "forged/oversized requests never reach the service");

let finish;
service.getEditDraft = () => new Promise((resolve) => { finish = resolve; });
const pending = handlers.get("collaboration:get-edit-draft")(null, { conversationId: "c", messageId: "m" });
service = { ok: true };
finish({ ok: true, conversationId: "c", messageId: "m", draft: { bodyText: "must not leak", baseRevision: 2, generation: 3, updatedAt: 4 } });
assert.equal((await pending).code, "COLLAB_ACCOUNT_CHANGED", "service replacement fences late plaintext");
for (const [method, channel, payload, result] of [
  ["saveEditDraft", "collaboration:save-edit-draft", { conversationId: "c", messageId: "m", bodyText: "x", baseRevision: 2, expectedGeneration: 3 }, { ok: true, conversationId: "c", messageId: "m", generation: 4, updatedAt: 5 }],
  ["clearEditDraft", "collaboration:clear-edit-draft", { conversationId: "c", messageId: "m", expectedGeneration: 4 }, { ok: true, conversationId: "c", messageId: "m", cleared: true }],
]) {
  service = { ok: true, [method]: () => new Promise((resolve) => { finish = resolve; }) };
  const late = handlers.get(channel)(null, payload);
  service = { ok: true };
  finish(result);
  assert.equal((await late).code, "COLLAB_ACCOUNT_CHANGED", `service replacement fences late ${method} result`);
}

const source = fs.readFileSync(new URL("../src/preload.js", import.meta.url), "utf8");
const block = source.match(/collaboration:\s*\{([\s\S]*?)\n\s*\},\n\s*onRuntimeEvents/)[1];
const bridgeCalls = [];
const bridge = vm.runInNewContext(`({${block}})`, { ipcRenderer: { invoke: (...args) => bridgeCalls.push(args) } });
bridge.getEditDraft({ conversationId: "c", messageId: "m", accountId: "forged" });
bridge.saveEditDraft({ conversationId: "c", messageId: "m", bodyText: "changed", baseRevision: 2, expectedGeneration: 3, path: "/tmp/x" });
bridge.clearEditDraft({ conversationId: "c", messageId: "m", expectedGeneration: 4, key: "forged" });
assert.deepEqual(JSON.parse(JSON.stringify(bridgeCalls)), [
  ["collaboration:get-edit-draft", { conversationId: "c", messageId: "m" }],
  ["collaboration:save-edit-draft", { conversationId: "c", messageId: "m", bodyText: "changed", baseRevision: 2, expectedGeneration: 3 }],
  ["collaboration:clear-edit-draft", { conversationId: "c", messageId: "m", expectedGeneration: 4 }],
]);

const raceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-edit-draft-fence-"));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() };
const makeRace = (name, afterRead) => {
  const store = new CollaborationStore({ dbPath: path.join(raceRoot, `${name}.db`), accountId: "alice",
    keyring: new LocalCollaborationKeyring({ filePath: path.join(raceRoot, `${name}-keys.json`), safeStorage }) });
  store.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','c','personal','direct',1)");
  store.hydrateAuthorizedHistory({ conversationId: "c", messages: [{ id: "m", seq: 1, senderUserId: "alice", bodyText: "original", revision: 2 }] });
  store.saveEditDraft({ conversationId: "c", messageId: "m", bodyText: "private", baseRevision: 2, expectedGeneration: 0 });
  const collaboration = createCollaborationService({ openStore: () => ({ ok: true, store }), realtimeEnabled: false });
  const original = store.getEditDraft.bind(store);
  store.getEditDraft = (input) => { const result = original(input); afterRead({ store, collaboration }); return result; };
  const raceHandlers = new Map();
  createCollaborationIpc({ ipcMain: { handle: (channel, fn) => raceHandlers.set(channel, fn) }, getService: () => collaboration });
  return { store, collaboration, invoke: () => raceHandlers.get("collaboration:get-edit-draft")(null, { conversationId: "c", messageId: "m" }) };
};
const stopped = makeRace("stopped", ({ collaboration }) => collaboration.stop());
assert.deepEqual(await stopped.invoke(), { ok: false, code: "COLLABORATION_STOPPED", retryable: false }, "stop fences decrypted late results");
const revoked = makeRace("revoked", ({ store }) => store.db.transaction(() => removeConversationRows(store, "c", "personal"))());
assert.deepEqual(await revoked.invoke(), { ok: false, code: "COLLAB_ACCESS_REVOKED", retryable: false }, "revocation fences decrypted late results");
assert.equal(revoked.store.db.get("SELECT 1 AS present FROM edit_drafts WHERE account_id='alice'"), undefined);
revoked.collaboration.stop();

const authorityStore = new CollaborationStore({ dbPath: path.join(raceRoot, "authority.db"), accountId: "alice",
  keyring: new LocalCollaborationKeyring({ filePath: path.join(raceRoot, "authority-keys.json"), safeStorage }) });
authorityStore.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','c','personal','direct',1)");
authorityStore.hydrateAuthorizedHistory({ conversationId: "c", messages: [
  { id: "peer", seq: 1, senderUserId: "bob", bodyText: "peer plaintext", revision: 1 },
  { id: "own", seq: 2, senderUserId: "alice", bodyText: "own plaintext", revision: 2 },
] });
const authority = createCollaborationService({ openStore: () => ({ ok: true, store: authorityStore }), realtimeEnabled: false });
const authorityHandlers = new Map();
createCollaborationIpc({ ipcMain: { handle: (channel, fn) => authorityHandlers.set(channel, fn) }, getService: () => authority });
for (const [channel, payload, code] of [
  ["collaboration:get-edit-draft", { conversationId: "c", messageId: "peer" }, "COLLAB_MESSAGE_EDIT_FORBIDDEN"],
  ["collaboration:save-edit-draft", { conversationId: "c", messageId: "own", bodyText: "private", baseRevision: 1, expectedGeneration: 0 }, "COLLAB_EDIT_DRAFT_BASE_MISMATCH"],
]) {
  const result = await authorityHandlers.get(channel)(null, payload);
  assert.deepEqual(result, { ok: false, code, retryable: false });
  assert.equal(JSON.stringify(result).includes("plaintext"), false, "authority failures expose no target body");
}
authority.stop();

console.log("collaboration edit draft IPC: strict payload, result and replacement fence");
