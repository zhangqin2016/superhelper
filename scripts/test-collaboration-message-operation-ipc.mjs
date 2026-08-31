#!/usr/bin/env node
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
const handlers = new Map(), calls = [];
const row = { id: "edit", conversationId: "c", clientCommandId: "edit", scopeId: "personal", commandType: "message.edit", messageId: "m", expectedRevision: 1,
  state: "failed", attempts: 0, deliveryConfirmed: false, deliveryUncertain: false, blockedBy: null, originalDeviceRequired: true, errorCode: "MESSAGE_REVISION_CONFLICT", bodyText: "own edit" };
const request = { conversationId: "c", outboxIds: ["edit", "absent"] };
const good = { ok: true, conversationId: "c", operations: [row], unavailableOutboxIds: ["absent"] };
let response = good;
let service = { ok: true, readMessageOperations: payload => { calls.push(payload); return response; }, skip: () => ({ ok: true, state: "confirming", canRevoke: true, requiresSync: true, recovery: "retry_or_sync", token: "hidden", bodyText: "hidden" }) };
createCollaborationIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, getService: () => service });
assert.equal(typeof handlers.get("collaboration:read-message-operations"), "function");
assert.equal(typeof handlers.get("collaboration:skip"), "function");
const invoke = payload => handlers.get("collaboration:read-message-operations")(null, payload);
assert.deepEqual(await invoke(request), good);
response = { ...good, privateKey: "hidden", operations: [{ ...row, originDeviceId: "hidden", token: "hidden", stack: "hidden", attachmentPaths: ["hidden"], payload: { body: "hidden" } }] };
assert.deepEqual(await invoke(request), good, "strict operation whitelist excludes secrets, origins, raw errors and envelopes");
for (const type of ["message.create", "message.revoke"]) {
  response = { ...good, operations: [{ ...row, commandType: type, bodyText: "never expose" }] };
  assert.equal(Object.hasOwn((await invoke(request)).operations[0], "bodyText"), false, "only persisted edits expose recovery text");
}
const ids200 = Array.from({ length: 200 }, (_, i) => `id-${i}`);
for (const outboxIds of [[], ids200]) {
  response = { ok: true, conversationId: "c", operations: [], unavailableOutboxIds: outboxIds };
  assert.deepEqual(await invoke({ conversationId: "c", outboxIds }), response);
}
const before = calls.length;
for (const payload of [{ ...request, token: "forged" }, { ...request, outboxIds: [...ids200, "201"] }, { ...request, outboxIds: ["edit", "edit"] }, { ...request, outboxIds: [" bad"] }, { ...request, outboxIds: [1] }, { ...request, outboxIds: undefined }, null]) assert.equal((await invoke(payload)).code, "COLLABORATION_INVALID_INPUT");
assert.equal(calls.length, before, "invalid requests never invoke service");
const forgeries = [undefined, {}, { ...good, ok: undefined }, { ...good, conversationId: "other" }, { ...good, operations: [] }, { ...good, operations: Array(1) }, { ...good, unavailableOutboxIds: ["edit"] }, { ...good, unavailableOutboxIds: ["wrong"] }, { ...good, operations: [row, row], unavailableOutboxIds: [] },
  ...[{ conversationId: "other" }, { id: "wrong" }, { scopeId: undefined }, { scopeId: "" }, { scopeId: " bad" }, { commandType: "unknown" }, { commandType: undefined }, { expectedRevision: "1" }, { expectedRevision: 0 }, { bodyText: null }, { bodyText: "x".repeat(65537) }, { attempts: "0" }, { attempts: -1 }, { state: "invented" }, { deliveryConfirmed: 1 }, { deliveryUncertain: undefined }, { originalDeviceRequired: "true" }, { errorCode: "secret from stack" }, { errorCode: undefined }, { blockedBy: undefined }, { blockedBy: "edit" }].map(patch => ({ ...good, operations: [{ ...row, ...patch }] }))];
for (const forged of forgeries) { response = forged; assert.deepEqual(await invoke(request), { ok: false, code: "COLLAB_MESSAGE_OPERATIONS_INVALID", retryable: false }, "no partial/forged recovery success"); }
assert.deepEqual(await handlers.get("collaboration:skip")(null, { outboxId: "edit" }), { ok: true, state: "confirming", canRevoke: true, requiresSync: true, recovery: "retry_or_sync" });
assert.equal((await handlers.get("collaboration:skip")(null, { outboxId: "edit", bodyText: "changed" })).ok, false);
service.skip = () => undefined;
assert.equal((await handlers.get("collaboration:skip")(null, { outboxId: "edit" })).ok, false, "skip cannot invent success");
let finish;
service.readMessageOperations = () => new Promise(resolve => { finish = resolve; });
const pending = invoke(request); service = { ok: true }; finish(good);
assert.equal((await pending).code, "COLLAB_ACCOUNT_CHANGED", "account replacement fences async view");
for (const action of ["retry", "skip", "cancel"]) {
  service = { ok: true, [action]: () => new Promise(resolve => { finish = resolve; }) };
  const pendingAction = handlers.get(`collaboration:${action}`)(null, { outboxId: "edit" });
  service = { ok: true }; finish({ ok: true, state: "cancelled" });
  assert.equal((await pendingAction).code, "COLLAB_ACCOUNT_CHANGED", "account replacement fences every pending recovery action");
}
const source = fs.readFileSync(new URL("../src/preload.js", import.meta.url), "utf8");
const block = source.match(/collaboration:\s*\{([\s\S]*?)\n\s*\},\n\s*onRuntimeEvents/);
const bridgeCalls = [];
const bridge = vm.runInNewContext(`({${block[1]}})`, { ipcRenderer: { invoke: (...args) => bridgeCalls.push(args) } });
bridge.readMessageOperations({ ...request, token: "forged", deviceId: "forged" }); bridge.skip("edit");
assert.deepEqual(JSON.parse(JSON.stringify(bridgeCalls)), [["collaboration:read-message-operations", request], ["collaboration:skip", { outboxId: "edit" }]], "preload forwards only the closed recovery vocabulary");

const raceDir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-operation-ipc-fence-"));
const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString() };
const makeRace = (name, afterRead) => {
  const raceStore = new CollaborationStore({ dbPath: path.join(raceDir, `${name}.db`), accountId: "alice", keyring: new LocalCollaborationKeyring({ filePath: path.join(raceDir, `${name}-keys.json`), safeStorage }) });
  raceStore.db.run("INSERT INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES('alice','c','personal','direct',1)");
  raceStore.persistMessageMutation({ commandType: "message.edit", conversationId: "c", messageId: "m", clientCommandId: "edit", expectedRevision: 1, bodyText: "must not escape after access changes", originDeviceId: "device-a" });
  const raceService = createCollaborationService({ openStore: () => ({ ok: true, store: raceStore }), deviceId: "device-a", realtimeEnabled: false });
  const originalRead = raceStore.readMessageOperations.bind(raceStore);
  raceStore.readMessageOperations = input => {
    const result = originalRead(input);
    afterRead({ service: raceService, store: raceStore });
    return result;
  };
  const raceHandlers = new Map();
  createCollaborationIpc({ ipcMain: { handle: (channel, handler) => raceHandlers.set(channel, handler) }, getService: () => raceService });
  return { raceService, raceStore, invoke: () => raceHandlers.get("collaboration:read-message-operations")(null, { conversationId: "c", outboxIds: ["edit"] }) };
};
try {
  const stoppedRace = makeRace("stopped", ({ service: current }) => current.stop());
  const stoppedResult = await stoppedRace.invoke();
  assert.deepEqual(stoppedResult, { ok: false, code: "COLLABORATION_STOPPED", retryable: false }, "a read finishing after stop cannot deliver decrypted operation content through IPC");

  const revokedRace = makeRace("revoked", ({ store: current }) => current.db.transaction(() => removeConversationRows(current, "c", "personal"))());
  const revokedResult = await revokedRace.invoke();
  assert.deepEqual(revokedResult, { ok: false, code: "COLLAB_ACCESS_REVOKED", retryable: false }, "a read finishing after production revocation cannot deliver decrypted operation content through IPC");
  revokedRace.raceService.stop();
} finally {
  fs.rmSync(raceDir, { recursive: true, force: true });
}
console.log("collaboration message operation IPC: ok");
