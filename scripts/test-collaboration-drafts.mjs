import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");
const { createCollaborationService } = require("../src/main/collaboration/service.js");
const { createCollaborationIpc } = require("../src/main/ipc-collaboration.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-drafts-"));
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage: {
  isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
} });
const dbPath = path.join(dir, "cache.db");
let store = new CollaborationStore({ dbPath, accountId: "alice", keyring });
const handlers = new Map();
let service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device-alice", transport: { submit: async () => ({}) } });
createCollaborationIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getService: () => service });
try {
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "a", kind: "direct" }, { id: "b", kind: "direct" }] });
  assert.ok(handlers.has("collaboration:save-draft"), "draft writes cross the validated main-process boundary");
  assert.equal((await handlers.get("collaboration:save-draft")(null, { conversationId: "a", text: "latest unsent text" })).ok, true);
  await handlers.get("collaboration:save-draft")(null, { conversationId: "b", text: "other conversation" });
  const initialSend = await service.send({ conversationId: "a", clientCommandId: "old-snapshot", bodyText: "older submitted text" });
  assert.equal(initialSend.ok, true, "draft preservation must exercise a successfully admitted older send");
  assert.equal((await handlers.get("collaboration:get-draft")(null, { conversationId: "a" })).text, "latest unsent text", "sending an older editor snapshot cannot clear newer input");
  service.stop();
  store = new CollaborationStore({ dbPath, accountId: "alice", keyring });
  service = createCollaborationService({ openStore: () => ({ ok: true, store }) });
  assert.equal((await handlers.get("collaboration:get-draft")(null, { conversationId: "b" })).text, "other conversation", "draft survives service and SQLite restart");
  const otherAccount = new CollaborationStore({ dbPath, accountId: "bob", keyring });
  assert.equal(otherAccount.getDraft({ conversationId: "b", draftId: "composer" }), null);
  otherAccount.close();
  for (const payload of [{ conversationId: "a", text: "x".repeat(65537) }, { conversationId: "a", text: "x", token: "leak" }]) {
    assert.equal((await handlers.get("collaboration:save-draft")(null, payload)).code, "COLLABORATION_INVALID_INPUT");
  }
  console.log("collaboration durable drafts passed");
} finally { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
