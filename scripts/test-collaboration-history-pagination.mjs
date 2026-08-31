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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collaboration-history-pages-"));
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage: {
  isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
} });
const store = new CollaborationStore({ dbPath: path.join(dir, "cache.db"), accountId: "alice", keyring });
try {
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "c", kind: "direct" }] });
  const messages = Array.from({ length: 451 }, (_, i) => ({ id: `m${i + 1}`, seq: (i + 1) * 2, bodyText: `line ${i + 1}`, revision: 1 }));
  store.hydrateAuthorizedHistory({ conversationId: "c", messages });
  store.persistDraftAndOptimisticMessage({ conversationId: "c", messageId: "pending", clientCommandId: "cmd", draftId: "composer", draftText: "", bodyText: "new" });
  const ids = new Set();
  let beforeSeq;
  for (let i = 0; i < 4; i++) {
    const page = store.listMessages({ conversationId: "c", limit: 200, ...(beforeSeq ? { beforeSeq } : {}) });
    const durable = page.filter((row) => row.seq != null);
    if (beforeSeq) assert.equal(page.some((row) => row.id === "pending"), false, "older windows cannot repeat pending tail");
    for (const row of durable) { assert.equal(ids.has(row.id), false, "keyset pages have no duplicate boundary message"); ids.add(row.id); }
    if (!durable.length) break;
    beforeSeq = durable[0].seq;
  }
  assert.equal(ids.size, 451, "all history is reachable despite event-sequence gaps and a pending message");
  for (const bad of [0, -1, 1.5, "bad", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.listMessages({ conversationId: "c", beforeSeq: bad }), /cursor/i);
  }
  let remoteBefore;
  const service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: "device", client: {
    async listMessageHistory({ beforeSeq, limit }) { remoteBefore = beforeSeq; return messages.filter((row) => beforeSeq == null || row.seq < beforeSeq).slice(-limit); },
  }, realtimeEnabled: false });
  store.db.run("INSERT INTO history_hydration (account_id,conversation_id,created_at) VALUES ('alice','c',0)");
  const older = await service.open({ conversationId: "c", beforeSeq: 402 });
  assert.equal(remoteBefore, 402, "older page cursor reaches the authorized HTTP history call");
  assert.equal(older.messages.length, 200); assert.equal(older.messages[0].seq, 2); assert.equal(older.messages.at(-1).seq, 400);
  assert.equal(older.hasMore, true); assert.equal(older.nextBeforeSeq, 2);
  assert.deepEqual(store.listPendingHistoryHydration(), ["c"], "reading old history cannot complete a pending newest-history checkpoint");
  const handlers = new Map();
  createCollaborationIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, getService: () => service });
  const last = await handlers.get("collaboration:open")(null, { conversationId: "c", beforeSeq: older.nextBeforeSeq });
  assert.equal(last.ok, true); assert.deepEqual(last.messages, []); assert.equal(last.hasMore, false); assert.equal(last.nextBeforeSeq, null);
  for (const beforeSeq of [0, "2", -1, 1.5]) {
    assert.equal((await handlers.get("collaboration:open")(null, { conversationId: "c", beforeSeq })).code, "COLLABORATION_INVALID_INPUT");
  }
  for (let i = 1; i < 200; i++) {
    store.persistDraftAndOptimisticMessage({ conversationId: "c", messageId: `pending-${i}`, clientCommandId: `cmd-${i}`, draftId: "composer", draftText: "", bodyText: "queued" });
  }
  const offlineService = createCollaborationService({ openStore: () => ({ ok: true, store }), realtimeEnabled: false });
  const cached = await offlineService.open({ conversationId: "c" });
  assert.equal(cached.offline, true);
  assert.equal(cached.messages.filter((row) => row.seq != null).length, 200, "pending tail cannot evict the cached durable window");
  assert.equal(cached.messages.filter((row) => row.seq == null).length, 200);
  assert.equal(cached.nextBeforeSeq, 504); assert.equal(cached.hasMore, true);
  const cachedOlder = await offlineService.open({ conversationId: "c", beforeSeq: cached.nextBeforeSeq });
  assert.equal(cachedOlder.messages.length, 200); assert.equal(cachedOlder.nextBeforeSeq, 104);
  console.log("collaboration history pagination passed");
} finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
