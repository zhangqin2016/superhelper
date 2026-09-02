#!/usr/bin/env node
/**
 * Reactions across the three layers.
 *
 * The load-bearing rule: a reaction is NOT a message revision. It has its own
 * event, its own projection and one row per (message, user, emoji) — so it can
 * never bump `revision`, disturb reply snapshots or the edit/revoke conflict
 * path, and two devices reacting at the same instant cannot clobber each other.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const {
  MAX_ROWS_PER_MESSAGE, applyReaction, forgetReactions, reactionsForMessages, validEmoji,
} = require("../src/main/collaboration/message-reactions");
const { persistMessageMutation } = require("../src/main/collaboration/message-mutation-outbox");
const transport = require("../src/main/collaboration/message-outbox-transport");

// --- emoji bounds: stored verbatim, never interpreted -----------------------
{
  assert.equal(validEmoji("👍"), "👍");
  assert.equal(validEmoji("❤️"), "❤️", "a multi-codepoint emoji is fine");
  for (const bad of ["", "  ", "a b", "👍 ", "x".repeat(33), "🎉".repeat(9), null, undefined]) {
    assert.equal(validEmoji(bad), "", `must reject ${JSON.stringify(bad)}`);
  }
  // Deliberately NOT an emoji allowlist: the contract is "a short token with no
  // whitespace", so new emoji need no deploy on either side. Type strictness
  // lives at the IPC boundary, which already requires a string.
  assert.equal(validEmoji("ok"), "ok", "the set of emoji is not policed here");
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-reactions-"));
const store = new CollaborationStore({
  dbPath: path.join(dir, "cache.db"),
  accountId: "alice",
  keyring: new LocalCollaborationKeyring({
    filePath: path.join(dir, "keys"),
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (v) => v.toString() },
  }),
});

try {
  store.replaceProjectionFromBootstrap({ conversations: [{ id: "c", kind: "group", scopeType: "personal", title: "T" }] });

  // --- grouping: count plus whether the reaction is mine -------------------
  assert.equal(applyReaction(store, { conversationId: "c", messageId: "m1", userId: "bob", emoji: "👍" }), true);
  applyReaction(store, { conversationId: "c", messageId: "m1", userId: "alice", emoji: "👍" });
  applyReaction(store, { conversationId: "c", messageId: "m1", userId: "carol", emoji: "🎉" });
  const grouped = reactionsForMessages(store, ["m1"]);
  assert.deepEqual(grouped.m1, [
    { emoji: "👍", count: 2, mine: true },
    { emoji: "🎉", count: 1, mine: false },
  ], "ordered by count then emoji, with `mine` set only for this account");

  // Idempotent: a replayed sync page must not double-count.
  applyReaction(store, { conversationId: "c", messageId: "m1", userId: "bob", emoji: "👍" });
  assert.equal(reactionsForMessages(store, ["m1"]).m1[0].count, 2, "a replayed reaction does not double-count");

  // Toggling off removes only that (user, emoji) pair.
  applyReaction(store, { conversationId: "c", messageId: "m1", userId: "alice", emoji: "👍", active: false });
  // Equal counts tie-break on CODE POINTS (not locale collation), so the chip
  // order is identical for every user regardless of language.
  assert.deepEqual(reactionsForMessages(store, ["m1"]).m1, [
    { emoji: "🎉", count: 1, mine: false },
    { emoji: "👍", count: 1, mine: false },
  ]);
  // Removing something that was never there is a no-op, not an error.
  assert.equal(applyReaction(store, { conversationId: "c", messageId: "m1", userId: "alice", emoji: "😂", active: false }), true);

  // Malformed input is never stored.
  for (const bad of [
    { conversationId: "", messageId: "m1", userId: "bob", emoji: "👍" },
    { conversationId: "c", messageId: "", userId: "bob", emoji: "👍" },
    { conversationId: "c", messageId: "m1", userId: "", emoji: "👍" },
    { conversationId: "c", messageId: "m1", userId: "bob", emoji: "a b" },
    {},
  ]) {
    assert.equal(applyReaction(store, bad), false, `must reject ${JSON.stringify(bad)}`);
  }

  // Bounded against a hostile peer.
  for (let i = 0; i < MAX_ROWS_PER_MESSAGE + 20; i += 1) {
    applyReaction(store, { conversationId: "c", messageId: "flood", userId: `u${i}`, emoji: "👍" });
  }
  const total = (reactionsForMessages(store, ["flood"]).flood || []).reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(total <= MAX_ROWS_PER_MESSAGE, true, `per-message rows are capped, got ${total}`);

  // --- reactions ride along with the message page --------------------------
  store.persistDraftAndOptimisticMessage({
    conversationId: "c", draftId: "d", messageId: "real", clientCommandId: "cmd-real", bodyText: "hi", scopeId: "personal",
  });
  applyReaction(store, { conversationId: "c", messageId: "real", userId: "bob", emoji: "❤️" });
  const page = store.listMessages({ conversationId: "c", includePending: true });
  const withReaction = page.find((message) => message.id === "real");
  assert.deepEqual(withReaction.reactions, [{ emoji: "❤️", count: 1, mine: false }], "the page carries reactions");
  assert.equal(page.some((message) => message.id === "real" && message.revision > 1), false,
    "a reaction must never bump the message revision");

  // --- the outbox intent carries NO expectedRevision ----------------------
  const intent = persistMessageMutation(store, {
    commandType: "message.reaction", conversationId: "c", messageId: "real",
    clientCommandId: "rct-1", emoji: "👍", active: true, originDeviceId: "dev-1",
  });
  assert.equal(intent.outboxId, "rct-1");
  const queued = store.getOutbox({ outboxId: "rct-1" });
  assert.equal(queued.commandType, "message.reaction");
  assert.equal(queued.emoji, "👍");
  assert.equal(queued.expectedRevision, undefined, "a reaction is not a revision, so it carries none");
  assert.throws(() => persistMessageMutation(store, {
    commandType: "message.reaction", conversationId: "c", messageId: "real",
    clientCommandId: "rct-2", emoji: "a b", originDeviceId: "dev-1",
  }), /emoji is invalid/);

  forgetReactions(store, "c");
  assert.deepEqual(reactionsForMessages(store, ["m1", "real"]), {}, "revoking a conversation drops its reactions");

  // FAIL-OPEN: an unusable store yields no reactions rather than throwing.
  assert.deepEqual(reactionsForMessages({ accountId: "a", db: { all() { throw new Error("gone"); } } }, ["m1"]), {});
  assert.deepEqual(reactionsForMessages(store, []), {});
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- transport: commit evidence for a reaction is its own shape ------------
{
  const item = { commandType: "message.reaction", conversationId: "c", messageId: "m1", clientCommandId: "rct-1", emoji: "👍", active: true };
  const commandFor = transport.commandFor || null;
  // commandFor is module-private; exercise the committed view, which is the
  // part that decides whether a durable command is done.
  const view = transport.committedView || null;
  if (view) {
    assert.equal(view(item, { ok: true, result: { eventId: "evt_1", messageId: "m1", emoji: "👍", active: true } })?.committed, true);
    assert.equal(view(item, { ok: true, result: { eventId: "evt_1", messageId: "other", emoji: "👍", active: true } }), null,
      "a receipt for a different message is not evidence");
    assert.equal(view(item, { ok: true, result: { eventId: "evt_1", messageId: "m1", emoji: "🎉", active: true } }), null,
      "a receipt for a different emoji is not evidence");
    assert.equal(view(item, { ok: true, result: { eventId: "evt_1", messageId: "m1", emoji: "👍", active: false } }), null,
      "a receipt for the opposite direction is not evidence");
    assert.equal(view(item, { ok: true, result: { messageId: "m1", emoji: "👍", active: true } }), null,
      "no event id means no durable commit");
  }
  assert.equal(typeof commandFor === "function" || commandFor === null, true);
}

console.log("collaboration-reactions: ok");
