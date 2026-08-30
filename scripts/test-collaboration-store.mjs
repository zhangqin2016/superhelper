#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CollaborationStore, openCollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-collab-store-"));
const dbPath = path.join(dir, "collaboration.db");
process.env.LILY_USER_DATA_DIR = dir;
const { collaborationDbPath, collaborationTransferRoot, messageDbPath } = require("../src/main/config.js");
assert.notEqual(collaborationDbPath(), messageDbPath(), "collaboration cache must never share the AI transcript database");
assert.equal(collaborationDbPath(), path.join(dir, "collaboration.db"));
assert.equal(collaborationTransferRoot(), path.join(dir, "collaboration-transfers"));
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
  decryptString: (value) => Buffer.from(value).toString("utf8").replace(/^protected:/, ""),
};
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keyring.json"), safeStorage });
const store = new CollaborationStore({ dbPath, accountId: "alice", keyring });
const tables = new Set(store.db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
for (const table of ["profiles", "conversations", "conversation_members", "events", "messages", "applied_events", "sync_state", "outbox", "drafts", "transfers", "share_mappings"]) {
  assert.ok(tables.has(table), `isolated collaboration cache includes ${table}`);
}
assert.equal([...tables].some((name) => /_fts$/i.test(name)), false, "encrypted message bodies never receive a plaintext FTS index");

let networkCalls = 0;
const queued = store.persistDraftAndOptimisticMessage({
  conversationId: "conversation-1",
  draftId: "draft-1",
  draftText: "first draft",
  messageId: "message-local-1",
  clientCommandId: "command-1",
  bodyText: "send this after commit",
  afterCommit: () => { networkCalls += 1; },
});
assert.equal(queued.outboxId, "command-1");
assert.equal(networkCalls, 1, "network work begins only after the SQLite transaction commits");
assert.equal(store.getDraft({ conversationId: "conversation-1", draftId: "draft-1" }).text, "first draft");
assert.equal(store.getMessage({ conversationId: "conversation-1", messageId: "message-local-1" }).bodyText, "send this after commit");
assert.deepEqual(store.listOutbox().map((row) => row.clientCommandId), ["command-1"]);

store.persistDraftAndOptimisticMessage({
  conversationId: "team-conversation-1",
  draftId: "team-draft-1",
  draftText: "team draft",
  messageId: "team-message-local-1",
  clientCommandId: "team-command-1",
  bodyText: "team payload must use its own scope key",
  scopeId: "team:design",
});
assert.equal(store.getOutbox({ outboxId: "team-command-1" }).scopeId, "team:design", "pending commands persist their authorization scope outside the encrypted envelope");

assert.equal(fs.readFileSync(dbPath).includes(Buffer.from("send this after commit")), false, "SQLite cache never stores plaintext message bodies");
assert.equal(fs.readFileSync(dbPath).includes(Buffer.from("first draft")), false, "SQLite cache never stores plaintext drafts");

let failedNetworkCall = 0;
assert.throws(
  () => store.persistDraftAndOptimisticMessage({
    conversationId: "conversation-1",
    draftId: "draft-bad",
    draftText: "must rollback",
    messageId: "message-local-bad",
    clientCommandId: "command-1",
    bodyText: "duplicate command",
    afterCommit: () => { failedNetworkCall += 1; },
  }),
  /UNIQUE constraint failed/i,
  "an outbox conflict rolls back the draft and optimistic message together",
);
assert.equal(failedNetworkCall, 0, "a rolled-back transaction never initiates the network request");
assert.equal(store.getDraft({ conversationId: "conversation-1", draftId: "draft-bad" }), null);
assert.equal(store.getMessage({ conversationId: "conversation-1", messageId: "message-local-bad" }), null);

store.close();
const reloaded = new CollaborationStore({ dbPath, accountId: "alice", keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, "keyring.json"), safeStorage }) });
assert.equal(reloaded.getMessage({ conversationId: "conversation-1", messageId: "message-local-1" }).bodyText, "send this after commit", "same-account cache survives restart encrypted");
assert.equal(reloaded.getOutbox({ outboxId: "team-command-1" }).bodyText, "team payload must use its own scope key", "a restart decrypts a pending Team outbox item using its persisted scope");
assert.deepEqual(reloaded.revokeScope({ scopeId: "team:design" }), { deletedOutbox: 1 }, "Team revocation removes pending commands before they can be transmitted");
assert.equal(reloaded.getOutbox({ outboxId: "team-command-1" }), null, "a revoked Team pending command cannot be retried");
reloaded.close();

// The cache is strictly disposable. A corrupt collaboration.db or SQLite lock
// must not make SessionManager's independent messages.db unreadable.
const transcriptPath = path.join(dir, "messages.db");
fs.writeFileSync(transcriptPath, "AI transcript sentinel", "utf8");
const corruptPath = path.join(dir, "corrupt-collaboration.db");
fs.writeFileSync(corruptPath, "not a SQLite database", "utf8");
const unavailable = openCollaborationStore({ dbPath: corruptPath, accountId: "alice", keyring });
assert.deepEqual(unavailable, { ok: false, code: "COLLABORATION_UNAVAILABLE" }, "a corrupt cache is isolated as collaboration unavailable");
assert.equal(fs.readFileSync(transcriptPath, "utf8"), "AI transcript sentinel", "cache recovery never reads, modifies, or deletes messages.db");

const lockedPath = path.join(dir, "locked-collaboration.db");
const lockHolder = spawn(process.execPath, ["-e", `
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(${JSON.stringify(lockedPath)});
  db.exec("PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE");
  process.stdout.write("locked\\n");
  setTimeout(() => { db.exec("COMMIT"); db.close(); }, 1_000);
`], { stdio: ["ignore", "pipe", "pipe"] });
await new Promise((resolve, reject) => {
  lockHolder.once("error", reject);
  lockHolder.stdout.once("data", resolve);
});
const locked = openCollaborationStore({ dbPath: lockedPath, accountId: "alice", keyring });
assert.deepEqual(locked, { ok: false, code: "COLLABORATION_UNAVAILABLE" }, "a real SQLite exclusive lock disables only collaboration instead of leaking into app startup");
await new Promise((resolve) => lockHolder.once("exit", resolve));

fs.rmSync(dir, { recursive: true, force: true });
console.log("collaboration store: ok");
