#!/usr/bin/env node
/**
 * The double tick: how far the OTHER members have read.
 *
 * The server already fanned `conversation.read` out to every member; the client
 * ingested only its OWN read event and dropped everyone else's, so an own
 * message could never show as read.
 *
 * A double tick is a claim about other people, so the rules are strict: it
 * means read by EVERY peer expected to read it, it never moves backwards, and
 * absent information yields no tick rather than an optimistic one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { forgetPeerReads, notePeerRead, peerReadWatermark } = require("../src/main/collaboration/peer-reads");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-peer-reads-"));
const store = new CollaborationStore({
  dbPath: path.join(dir, "cache.db"),
  accountId: "alice",
  keyring: new LocalCollaborationKeyring({
    filePath: path.join(dir, "keys"),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() },
  }),
});

try {
  // Members are a top-level collection in the bootstrap snapshot, not nested
  // inside each conversation.
  store.replaceProjectionFromBootstrap({
    conversations: [
      { id: "direct", kind: "direct", scopeType: "personal", title: "Bob" },
      { id: "group", kind: "group", scopeType: "personal", title: "Team" },
    ],
    members: [
      { conversationId: "direct", userId: "alice", role: "member" },
      { conversationId: "direct", userId: "bob", role: "member" },
      { conversationId: "group", userId: "alice", role: "owner" },
      { conversationId: "group", userId: "bob", role: "member" },
      { conversationId: "group", userId: "carol", role: "member" },
    ],
  });
  assert.equal(store.listConversationMembers({ conversationId: "group" }).length, 3, "fixture really stored membership");

  // Nothing reported yet → no double ticks. This is the pre-existing behaviour
  // and the only honest default.
  assert.equal(peerReadWatermark(store, "direct"), 0, "no reports → no read claim");

  // 1:1 — the single peer's watermark is the conversation's.
  assert.equal(notePeerRead(store, { conversationId: "direct", userId: "bob", lastReadSeq: 7 }), true);
  assert.equal(peerReadWatermark(store, "direct"), 7);

  // Monotonic: a replayed or out-of-order page cannot walk a tick backwards.
  notePeerRead(store, { conversationId: "direct", userId: "bob", lastReadSeq: 3 });
  assert.equal(peerReadWatermark(store, "direct"), 7, "a lower seq never regresses the watermark");
  notePeerRead(store, { conversationId: "direct", userId: "bob", lastReadSeq: 9 });
  assert.equal(peerReadWatermark(store, "direct"), 9);

  // Group — "read" means read by ALL peers, so the slowest one holds it back.
  notePeerRead(store, { conversationId: "group", userId: "bob", lastReadSeq: 50 });
  assert.equal(peerReadWatermark(store, "group"), 0, "one fast reader must not claim read-by-all");
  notePeerRead(store, { conversationId: "group", userId: "carol", lastReadSeq: 20 });
  assert.equal(peerReadWatermark(store, "group"), 20, "the slowest peer sets the watermark");
  notePeerRead(store, { conversationId: "group", userId: "carol", lastReadSeq: 60 });
  assert.equal(peerReadWatermark(store, "group"), 50, "now bob is the slowest");

  // Own reads are not peer reads — otherwise every message would self-confirm.
  assert.equal(notePeerRead(store, { conversationId: "direct", userId: "alice", lastReadSeq: 999 }), false);
  assert.equal(peerReadWatermark(store, "direct"), 9, "the account can never mark its own message read");

  // Malformed input is rejected, never stored.
  for (const bad of [
    { conversationId: "", userId: "bob", lastReadSeq: 5 },
    { conversationId: "direct", userId: "", lastReadSeq: 5 },
    { conversationId: "direct", userId: "bob", lastReadSeq: -1 },
    { conversationId: "direct", userId: "bob", lastReadSeq: 1.5 },
    { conversationId: "direct", userId: "bob", lastReadSeq: "abc" },
    { conversationId: "direct", userId: "bob" },
    {},
  ]) {
    assert.equal(notePeerRead(store, bad), false, `must reject ${JSON.stringify(bad)}`);
  }
  assert.equal(peerReadWatermark(store, "direct"), 9, "rejected input left the watermark untouched");

  // A numeric string IS accepted, on purpose: it coerces to the same number and
  // matches how the IPC layer already treats integers, so a serializer that
  // stringifies numbers cannot silently cost the user their read receipts.
  assert.equal(notePeerRead(store, { conversationId: "direct", userId: "bob", lastReadSeq: "12" }), true);
  assert.equal(peerReadWatermark(store, "direct"), 12);

  // The conversation projection carries it, so the renderer needs no extra call.
  assert.equal(store.getConversation({ conversationId: "direct" }).peerReadSeq, 12);
  assert.equal(store.listConversations().find((c) => c.id === "group").peerReadSeq, 50);

  // Cleanup on revoke / account change.
  forgetPeerReads(store, "direct");
  assert.equal(peerReadWatermark(store, "direct"), 0);
  assert.equal(peerReadWatermark(store, "group"), 50, "forgetting one conversation leaves the others");
  forgetPeerReads(store);
  assert.equal(peerReadWatermark(store, "group"), 0);

  // FAIL-OPEN: an unusable store must yield "no read", never throw and never
  // take the conversation list down with it.
  assert.equal(peerReadWatermark({ accountId: "alice", db: { all() { throw new Error("db gone"); } } }, "direct"), 0);
  // Membership unknown: reports exist but we cannot know who still has to read,
  // so there is no honest read-by-all claim.
  assert.equal(
    peerReadWatermark({ accountId: "alice", db: { all: () => [{ user_id: "bob", last_read_seq: 99 }] } }, "direct"),
    0,
    "unknown membership must not be filled in from whoever happened to report",
  );
  assert.equal(peerReadWatermark(store, ""), 0);
  assert.doesNotThrow(() => forgetPeerReads({ accountId: "a", db: { run() { throw new Error("x"); } } }, "direct"));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("collaboration-peer-reads: ok");
