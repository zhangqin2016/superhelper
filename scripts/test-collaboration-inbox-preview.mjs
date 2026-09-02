#!/usr/bin/env node
/**
 * A chat list row must show the LAST MESSAGE.
 *
 * The row's second line used to be the conversation's scope ("个人" / a team
 * name) — constant per row, so the list told the user nothing about what had
 * happened and did not read as a messenger at all. The body already lives in
 * the local encrypted store with a local `_decrypt`, so the preview is a local
 * read: no server work, and no new data leaves the device.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-inbox-preview-"));
const store = new CollaborationStore({
  dbPath: path.join(dir, "cache.db"),
  accountId: "alice",
  keyring: new LocalCollaborationKeyring({
    filePath: path.join(dir, "keys"),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() },
  }),
});

try {
  store.replaceProjectionFromBootstrap({
    conversations: [
      { id: "chatty", kind: "direct", scopeType: "personal", title: "Bob" },
      { id: "silent", kind: "direct", scopeType: "personal", title: "Nobody" },
    ],
  });

  // A conversation with no messages has no preview — the row falls back to the
  // scope label, exactly as before.
  const before = store.listConversations().find((c) => c.id === "chatty");
  assert.equal(before.lastMessage, null, "no messages → no preview, never a fabricated one");

  store.persistDraftAndOptimisticMessage({
    conversationId: "chatty", draftId: "d1", messageId: "m1", clientCommandId: "cmd1",
    bodyText: "  first   line\nsecond line  ", scopeId: "personal",
  });
  const one = store.listConversations().find((c) => c.id === "chatty");
  assert.equal(one.lastMessage.text, "first line second line", "preview is a single collapsed line");
  assert.equal(one.lastMessage.senderUserId, "", "an optimistic local message has no server sender id yet");

  // The NEWEST message wins.
  store.persistDraftAndOptimisticMessage({
    conversationId: "chatty", draftId: "d1", messageId: "m2", clientCommandId: "cmd2",
    bodyText: "newest", scopeId: "personal",
  });
  assert.equal(
    store.listConversations().find((c) => c.id === "chatty").lastMessage.text,
    "newest",
    "the newest message is the preview",
  );

  // Long bodies are bounded so the row can never be blown open by one message.
  store.persistDraftAndOptimisticMessage({
    conversationId: "chatty", draftId: "d1", messageId: "m3", clientCommandId: "cmd3",
    bodyText: "x".repeat(4000), scopeId: "personal",
  });
  assert.equal(store.listConversations().find((c) => c.id === "chatty").lastMessage.text.length, 160, "preview is length-capped");

  // A whitespace-only body is not a preview.
  store.persistDraftAndOptimisticMessage({
    conversationId: "chatty", draftId: "d1", messageId: "m4", clientCommandId: "cmd4",
    bodyText: "   \n  ", scopeId: "personal",
  });
  assert.equal(store.listConversations().find((c) => c.id === "chatty").lastMessage, null, "blank body yields no preview");

  // Untouched conversations stay untouched, and the rest of the row projection
  // keeps its existing shape.
  const silent = store.listConversations().find((c) => c.id === "silent");
  assert.equal(silent.lastMessage, null);
  assert.equal(silent.title, "Nobody");
  assert.equal(typeof silent.updatedAt, "number");

  // FAIL-OPEN: an unreadable body must degrade to no preview, never throw and
  // never take the whole conversation list down with it.
  const broken = Object.create(Object.getPrototypeOf(store));
  Object.assign(broken, store);
  broken._decrypt = () => { throw new Error("key unavailable"); };
  assert.doesNotThrow(() => broken.listConversations(), "an undecryptable message cannot break the list");
  assert.equal(broken.listConversations().every((c) => c.lastMessage === null), true, "undecryptable → no preview");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("collaboration-inbox-preview: ok");
