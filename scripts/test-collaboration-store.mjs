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
assert.equal(collaborationTransferRoot(), path.join(dir, "collaboration-transfer"), "store retirement and runtime share one canonical encrypted-transfer root");
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, "utf8"),
  decryptString: (value) => Buffer.from(value).toString("utf8").replace(/^protected:/, ""),
};
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keyring.json"), safeStorage });
const store = new CollaborationStore({ dbPath, accountId: "alice", keyring });
const tables = new Set(store.db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
for (const table of ["profiles", "conversations", "conversation_members", "events", "messages", "applied_events", "sync_state", "outbox", "drafts", "transfers", "share_mappings", "history_hydration"]) {
  assert.ok(tables.has(table), `isolated collaboration cache includes ${table}`);
}
assert.equal([...tables].some((name) => /_fts$/i.test(name)), false, "encrypted message bodies never receive a plaintext FTS index");
store.replaceProjectionFromBootstrap({ watermark: 0, conversations: [{ id: "conversation-1", kind: "direct" }] });

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
store.saveDraft({ conversationId: "conversation-1", text: "ordinary message" });
store.persistDraftAndOptimisticMessage({
  conversationId: "conversation-1", draftId: "composer", draftText: "", messageId: "message-normal-clear",
  clientCommandId: "command-normal-clear", bodyText: "ordinary message",
});
assert.equal(store.getDraft({ conversationId: "conversation-1", draftId: "composer" }).text, "",
  "ordinary text send retains its established behavior of consuming the matching composer draft");

store.applySyncPage({
  fromCursor: 0, toCursor: 1,
  events: [{ id: "event-history-pending", cursor: 1, type: "message.created", conversationId: "conversation-1", payload: {} }],
  historyHydrationConversationIds: ["conversation-1"],
});
assert.deepEqual(store.listPendingHistoryHydration(), ["conversation-1"], "a message page atomically records its required authorized-history hydration before its cursor advances");

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

store.persistDraftAndOptimisticMessage({
  conversationId: "conversation-1", draftId: "attachment-draft", draftText: "", messageId: "attachment-local-1",
  clientCommandId: "attachment-command-1", bodyText: "design brief", attachmentIds: ["object-a", "object-b"], attachmentPurpose: "attachment",
});
assert.deepEqual(store.getMessage({ conversationId: "conversation-1", messageId: "attachment-local-1" }).attachmentIds, ["object-a", "object-b"], "optimistic attachment references are encrypted with the local message");
assert.equal(store.getMessage({ conversationId: "conversation-1", messageId: "attachment-local-1" }).kind, "attachment");
assert.throws(() => store.persistDraftAndOptimisticMessage({
  conversationId: "conversation-1", draftId: "attachment-invalid", draftText: "", messageId: "attachment-invalid",
  clientCommandId: "attachment-invalid", bodyText: "invalid", attachmentIds: [123], attachmentPurpose: "attachment",
}), /attachment intent is invalid/, "attachment object identifiers are strict strings; numeric coercion cannot create a divergent local/server command");

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
assert.deepEqual(reloaded.listPendingHistoryHydration(), ["conversation-1"], "a crash after page commit retains the hydration checkpoint for startup recovery");
assert.deepEqual(reloaded.completeHistoryHydration({ conversationId: "conversation-1" }), { completed: 1 });
assert.deepEqual(reloaded.listPendingHistoryHydration(), [], "only a completed authorized history hydration clears the checkpoint");
reloaded.replaceProjectionFromBootstrap({ watermark: 1, conversations: [{ id: "conversation-1", kind: "direct" }] });
assert.deepEqual(reloaded.getMessage({ conversationId: "conversation-1", messageId: "attachment-local-1" }).attachmentIds, ["object-a", "object-b"], "bootstrap rebuilding a confirming bubble keeps its attachment references");
assert.equal(reloaded.getMessage({ conversationId: "conversation-1", messageId: "attachment-local-1" }).kind, "attachment", "bootstrap rebuilding a confirming bubble keeps its kind");
assert.equal(reloaded.getOutbox({ outboxId: "team-command-1" }).bodyText, "team payload must use its own scope key", "a restart decrypts a pending Team outbox item using its persisted scope");
reloaded.applySyncPage({
  fromCursor: 1, toCursor: 2,
  events: [{ id: "event-revoked-history", cursor: 2, type: "message.created", conversationId: "revoked-conversation", payload: {} }],
  historyHydrationConversationIds: ["revoked-conversation"],
});
assert.deepEqual(reloaded.listPendingHistoryHydration(), ["revoked-conversation"], "an old revoked conversation can remain pending immediately before a full resync");
reloaded.replaceProjectionFromBootstrap({
  watermark: 3,
  conversations: [{ id: "org-conversation", scope_type: "organization", organization_id: "org-design", kind: "group", title: "Design" }],
});
assert.deepEqual(reloaded.listPendingHistoryHydration(), [], "full resync drops obsolete hydration checkpoints so revoked history cannot block future cursor sync");
assert.equal(reloaded.getConversation({ conversationId: "org-conversation" }).scopeId, "team:org-design", "raw organization bootstrap rows retain a Team scope at the local projection boundary");
assert.deepEqual(reloaded.hydrateAuthorizedHistory({ conversationId: "org-conversation", messages: [{ id: "server-history-1", createSeq: 1, senderUserId: "bob", bodyText: "authorized server history" }] }), { hydrated: 1 });
assert.equal(reloaded.getMessage({ conversationId: "org-conversation", messageId: "server-history-1" }).bodyText, "authorized server history", "only the authorized server history view is encrypted into the local projection");
assert.equal(fs.readFileSync(dbPath).includes(Buffer.from("authorized server history")), false, "authorized history remains encrypted at rest locally");
reloaded.persistDraftAndOptimisticMessage({
  conversationId: "org-conversation", draftId: "org-draft", draftText: "", messageId: "org-message", clientCommandId: "org-command", bodyText: "scoped", scopeId: reloaded.getConversation({ conversationId: "org-conversation" }).scopeId,
});
assert.equal(reloaded.getOutbox({ outboxId: "org-command" }).scopeId, "team:org-design", "Team bootstrap scope reaches durable outbox encryption metadata");
assert.deepEqual(reloaded.revokeScope({ scopeId: "team:org-design" }), { deletedOutbox: 1 }, "Team scope revocation targets bootstrap-created organization outbox rows");
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
