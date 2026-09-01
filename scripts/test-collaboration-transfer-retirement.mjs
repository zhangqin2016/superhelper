#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");
const { createTransferRuntime } = require("../src/main/collaboration/transfer-runtime.js");
const { retiredTransferIds, retireScopeTransfers } = require("../src/main/collaboration/transfer-retirement.js");
const { removeScopeRows } = require("../src/main/collaboration/access-revocation.js");

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-transfer-retirement-")));
const rootPath = path.join(dir, "collaboration-transfer");
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => Buffer.from(value).toString() };
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keyring.json"), safeStorage });
const store = new CollaborationStore({ dbPath: path.join(dir, "collaboration.db"), accountId: "alice", keyring, transferRoot: rootPath });
const sourcePath = path.join(dir, "team-brief.txt");
fs.writeFileSync(sourcePath, "team brief", "utf8");

try {
  store.replaceProjectionFromBootstrap({ watermark: 0, conversations: [
    { id: "personal-conversation", kind: "direct", scopeId: "personal" },
    { id: "team-conversation", kind: "channel", scopeId: "team:org" },
  ], teams: [{ id: "org", status: "active" }] });
  const runtime = createTransferRuntime({
    store, client: { objects: {} }, deviceId: "device", policy: { enabled: true, attachments: true }, rootPath,
    chooseFile: async () => ({ canceled: false, filePaths: [sourcePath] }), assertActive() {},
  });
  const teamTransfer = await runtime.prepareAttachment({ conversationId: "team-conversation" });
  assert.equal(teamTransfer.ok, true);
  const teamIntent = runtime.createSendIntent({ conversationId: "team-conversation", transferIds: [teamTransfer.id], bodyText: "retired Team message" });
  store.revokeScope({ scopeId: "team:org" });
  const personalTransfer = await runtime.prepareAttachment({ conversationId: "personal-conversation" });
  assert.equal(personalTransfer.ok, true, "a retired Team transfer with a destroyed scope key cannot poison new personal attachment preparation");
  assert.equal(runtime.createSendIntent({ conversationId: "personal-conversation", transferIds: [personalTransfer.id], bodyText: "personal message" }).status, "waiting_attachments",
    "the retired Team manifest is ignored by the claimed-intent scan, so a new personal message can be durably scheduled");
  store.replaceProjectionFromBootstrap({ watermark: 1, conversations: [
    { id: "personal-conversation", kind: "direct", scopeId: "personal" },
    { id: "team-conversation", kind: "channel", scopeId: "team:org" },
  ], teams: [{ id: "org", status: "active" }] });
  // A later roster re-enable creates a fresh Team key but cannot revive a
  // manifest that was deliberately retired while the former key was valid.
  keyring.encrypt({ accountId: "alice", scopeId: "team:org", recordId: "new-team-record", plaintext: "new key" });
  const afterReenable = runtime.list();
  assert.equal(afterReenable.unrecognizedCount, 0, "a trusted retired ID is omitted from both readable and unreadable transfer scan views");
  assert.equal(afterReenable.transfers.some((transfer) => transfer.id === teamTransfer.id), false, "retired Team transfer never returns to a re-enabled roster");
  assert.ok(retiredTransferIds({ rootPath, accountId: "alice", keyring }).has(teamTransfer.id));
  assert.throws(() => runtime.handoffIntent(teamIntent), (error) => ["COLLAB_ACCESS_REVOKED", "COLLAB_TRANSFER_UNAVAILABLE"].includes(error?.code),
    "retired transfer is permanently fenced from message handoff even after Team re-enable");
  assert.notEqual(personalTransfer.id, teamTransfer.id);
  runtime.stop();
  console.log("collaboration transfer retirement: Team key destruction retires authenticated manifests without blocking personal transfers");
} finally {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// A destroyed Team key cannot be recovered by an outer-manifest scope edit:
// retirement accepts IDs only from a full authenticated manifest scan.
const tamperDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-transfer-retirement-tamper-")));
const tamperRoot = path.join(tamperDir, "collaboration-transfer");
const tamperKeyring = new LocalCollaborationKeyring({ filePath: path.join(tamperDir, "keys"), safeStorage });
const tamperStore = new CollaborationStore({ dbPath: path.join(tamperDir, "cache.db"), accountId: "alice", keyring: tamperKeyring, transferRoot: tamperRoot });
try {
  tamperStore.replaceProjectionFromBootstrap({ watermark: 0, conversations: [{ id: "personal", kind: "direct", scopeId: "personal" }] });
  const source = path.join(tamperDir, "personal.txt"); fs.writeFileSync(source, "personal", "utf8");
  const runtime = createTransferRuntime({ store: tamperStore, client: { objects: {} }, deviceId: "device", policy: { enabled: true, attachments: true }, rootPath: tamperRoot,
    chooseFile: async () => ({ canceled: false, filePaths: [source] }), assertActive() {} });
  const personal = await runtime.prepareAttachment({ conversationId: "personal" });
  const manifestFile = path.join(require("../src/main/collaboration/transfer-manifest.js").createTransferManifestStore({ rootPath: tamperRoot, accountId: "alice", keyring: tamperKeyring }).directory(personal.id), "manifest.json");
  const outer = JSON.parse(fs.readFileSync(manifestFile, "utf8")); outer.scopeId = "team:org"; fs.writeFileSync(manifestFile, JSON.stringify(outer), "utf8");
  assert.deepEqual(retireScopeTransfers({ rootPath: tamperRoot, accountId: "alice", keyring: tamperKeyring, scopeId: "team:org" }), { retired: 0 });
  assert.equal(retiredTransferIds({ rootPath: tamperRoot, accountId: "alice", keyring: tamperKeyring }).has(personal.id), false,
    "unauthenticated outer scope metadata cannot retire an otherwise personal transfer");
  runtime.stop();
} finally { tamperStore.close(); fs.rmSync(tamperDir, { recursive: true, force: true }); }

// If the process exits after the protected retirement marker but before the
// key deletion, the durable key_delete_pending row retries the same ordering
// on the next store construction; it never silently restores Team access.
const crashDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-transfer-retirement-crash-")));
const crashRoot = path.join(crashDir, "collaboration-transfer");
const crashKeyring = new LocalCollaborationKeyring({ filePath: path.join(crashDir, "keys"), safeStorage });
let crashStore = new CollaborationStore({ dbPath: path.join(crashDir, "cache.db"), accountId: "alice", keyring: crashKeyring, transferRoot: crashRoot });
try {
  crashStore.replaceProjectionFromBootstrap({ watermark: 0, conversations: [
    { id: "personal", kind: "direct", scopeId: "personal" }, { id: "team", kind: "channel", scopeId: "team:org" },
  ], teams: [{ id: "org", status: "active" }] });
  const source = path.join(crashDir, "team.txt"); fs.writeFileSync(source, "team", "utf8");
  const runtime = createTransferRuntime({ store: crashStore, client: { objects: {} }, deviceId: "device", policy: { enabled: true, attachments: true }, rootPath: crashRoot,
    chooseFile: async () => ({ canceled: false, filePaths: [source] }), assertActive() {} });
  const team = await runtime.prepareAttachment({ conversationId: "team" }); runtime.stop();
  assert.equal(retireScopeTransfers({ rootPath: crashRoot, accountId: "alice", keyring: crashKeyring, scopeId: "team:org" }).retired, 1);
  crashStore.db.transaction(() => removeScopeRows(crashStore, "team:org"))();
  assert.equal(crashStore.db.get("SELECT key_delete_pending FROM revoked_scopes WHERE account_id = 'alice' AND scope_id = 'team:org'").key_delete_pending, 1);
  crashStore.close();
  crashStore = new CollaborationStore({ dbPath: path.join(crashDir, "cache.db"), accountId: "alice", keyring: crashKeyring, transferRoot: crashRoot });
  assert.equal(crashStore.db.get("SELECT key_delete_pending FROM revoked_scopes WHERE account_id = 'alice' AND scope_id = 'team:org'").key_delete_pending, 0,
    "restart completes the still-pending Team key deletion after marker persistence");
  assert.throws(() => crashKeyring.decrypt({ accountId: "alice", scopeId: "team:org", recordId: "probe", envelope: {} }));
  assert.ok(retiredTransferIds({ rootPath: crashRoot, accountId: "alice", keyring: crashKeyring }).has(team.id));
} finally { crashStore.close(); fs.rmSync(crashDir, { recursive: true, force: true }); }

const emptyDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lily-transfer-retirement-empty-")));
try {
  const missingRoot = path.join(emptyDir, "collaboration-transfer");
  assert.deepEqual(retireScopeTransfers({ rootPath: missingRoot, accountId: "alice", keyring, scopeId: "team:org" }), { retired: 0 }, "a missing optional transfer root is a read-only no-op");
  assert.equal(fs.existsSync(missingRoot), false, "ordinary text-only revocation never creates attachment staging");
} finally { fs.rmSync(emptyDir, { recursive: true, force: true }); }
