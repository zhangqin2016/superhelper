#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");
const { createCollaborationOutbox } = require("../src/main/collaboration/outbox.js");
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { COLLABORATION_MIGRATIONS } = require("../src/main/collaboration/schema.js");
const unknown = () => Object.assign(new Error("ACK lost"), { code: "COLLAB_RESPONSE_UNKNOWN" });
const offline = () => Object.assign(new Error("offline"), { code: "COLLAB_NETWORK_UNAVAILABLE" });
const receipt = (id = "one", sequence = 1) => ({ committed: true, eventId: `event-${id}`, messageId: `server-${id}`, sequence });
const unknownReceipt = () => ({ state: "unknown", committed: false, deliveryUnknown: true });

function fixture(t, transport, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-collab-unknown-"));
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text), decryptString: (bytes) => Buffer.from(bytes).toString(),
  } });
  const open = () => new CollaborationStore({ dbPath: path.join(dir, "collaboration.db"), accountId: "alice", keyring });
  let store = open();
  let outbox;
  let timerId = 0;
  const timers = new Map();
  const delays = [];
  const create = () => createCollaborationOutbox({ store, transport, maxAutoRetries: 3, retryBaseMs: 10, retryMaxMs: 100,
    setTimeoutFn: (fn, delay) => { const id = ++timerId; timers.set(id, fn); delays.push(delay); return id; },
    clearTimeoutFn: (id) => timers.delete(id), ...options,
  });
  outbox = create();
  t.after(() => { outbox.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const add = (id = "one", conversationId = "conversation") => store.persistDraftAndOptimisticMessage({
    conversationId, clientCommandId: id, messageId: `local-${id}`, draftId: `draft-${id}`,
    draftText: "editable draft", bodyText: `original body ${id}`, scopeId: "personal",
  });
  add();
  return { get store() { return store; }, get outbox() { return outbox; }, timers, delays, add,
    row: (id = "one") => store.getOutbox({ outboxId: id }),
    async tick() { const timer = timers.entries().next().value; assert.ok(timer, "unknown delivery schedules a bounded recovery check"); timers.delete(timer[0]); await timer[1](); },
    restart() { outbox.stop(); store.close(); store = open(); store.recoverAbandonedSubmittingOutbox(); outbox = create(); },
  };
}

test("uncommitted ambiguous send recovers automatically with original immutable command", async (t) => {
  const sent = [];
  let committed = false;
  const f = fixture(t, {
    async submit(item) { sent.push(structuredClone(item)); if (sent.length === 1) { item.bodyText = "transport mutation"; throw unknown(); } committed = true; },
    async lookupReceipt() { return committed ? receipt() : unknownReceipt(); },
  });
  await f.outbox.submit("one");
  await f.tick();
  assert.equal(sent.length, 2, "a pre-commit timeout cannot strand the lane forever");
  for (const item of sent) assert.deepEqual([item.clientCommandId, item.conversationId, item.bodyText], ["one", "conversation", "original body one"]);
  await f.outbox.reconcilePending();
  assert.equal(f.row().state, "persisted");
  assert.equal(f.store.countMessages({ conversationId: "conversation" }), 1);
});

test("committed ACK loss with stale receipt replays the same key exactly once on the server", async (t) => {
  const commits = new Map();
  let sends = 0;
  let lookups = 0;
  const f = fixture(t, {
    async submit(item) { sends += 1; if (!commits.has(item.clientCommandId)) commits.set(item.clientCommandId, receipt()); if (sends === 1) throw unknown(); },
    async lookupReceipt() { return ++lookups === 1 ? unknownReceipt() : commits.get("one"); },
  });
  await f.outbox.submit("one");
  await f.tick();
  await f.outbox.reconcilePending();
  assert.equal(sends, 2);
  assert.equal(commits.size, 1);
  assert.equal(f.row().state, "persisted");
  assert.equal(f.store.countMessages(), 1);
});

test("repeated unknown is bounded, stays a barrier, and only manual continuation replays", async (t) => {
  const sent = [];
  let recover = false;
  const f = fixture(t, {
    async submit(item) { sent.push(item.clientCommandId); if (!recover) throw unknown(); },
    async lookupReceipt() { return unknownReceipt(); },
  });
  f.add("two"); f.add("other", "other-conversation");
  await f.outbox.submit("one");
  assert.equal((await f.outbox.submit("two")).blockedBy, "one");
  await f.tick(); await f.tick(); await f.tick();
  assert.equal(f.row().state, "delivery_unknown");
  assert.equal(f.row().attempts, 3);
  assert.deepEqual(f.delays, [10, 20, 40]);
  assert.deepEqual(sent, ["one", "one", "one"]);
  assert.equal(f.timers.size, 0);
  await f.outbox.reconcilePending();
  await f.outbox.submit("two");
  assert.deepEqual(sent, ["one", "one", "one"], "unknown or exhaustion never unblocks later same-conversation work");
  recover = true;
  await f.outbox.submit("other");
  assert.equal(sent.at(-1), "other", "independent conversations still work");
  assert.equal(f.outbox.continue("one").state, "queued");
  await f.outbox.submit("one");
  await f.outbox.submit("two");
  assert.deepEqual(sent.slice(-2), ["one", "two"], "confirmed original command releases the same-conversation barrier");
});

test("receipt transport failures back off without sending and eventually expose delivery_unknown", async (t) => {
  let sends = 0;
  const f = fixture(t, { async submit() { sends += 1; throw unknown(); }, async lookupReceipt() { throw offline(); } });
  await f.outbox.submit("one");
  await f.tick();
  await f.outbox.reconcilePending();
  assert.equal(f.row().attempts, 1, "frequent sync cannot bypass the recovery backoff");
  await f.tick(); await f.tick();
  assert.equal(sends, 1, "lookup failure is not permission to dispatch again");
  assert.equal(f.row().state, "delivery_unknown");
  assert.equal(f.timers.size, 0);
});

test("cancelled unknown survives timers and restart without silently sending", async (t) => {
  let sends = 0;
  const f = fixture(t, { async submit() { sends += 1; throw unknown(); }, async lookupReceipt() { return unknownReceipt(); } });
  await f.outbox.submit("one");
  assert.equal((await f.outbox.cancel("one")).state, "delivery_unknown");
  while (f.timers.size) await f.tick();
  await f.outbox.reconcilePending();
  f.restart();
  await f.outbox.reconcilePending(); await f.outbox.drainQueued();
  assert.equal(sends, 1);
  assert.equal(f.row().state, "delivery_unknown");
  assert.equal(f.timers.size, 0);
});

test("restart retains unknown retry budget and original body", async (t) => {
  const sent = [];
  const f = fixture(t, { async submit(item) { sent.push([item.clientCommandId, item.bodyText]); throw unknown(); }, async lookupReceipt() { return unknownReceipt(); } });
  await f.outbox.submit("one"); await f.tick();
  assert.equal(f.row().attempts, 1);
  f.restart();
  await f.outbox.reconcilePending();
  while (f.timers.size) await f.tick();
  assert.equal(f.row().attempts, 3);
  assert.equal(f.row().state, "delivery_unknown");
  assert.equal(sent.length, 3, "restart must not replenish automatic replay allowance");
  assert.ok(sent.every(([id, body]) => id === "one" && body === "original body one"));
});

test("successful ACK never replays merely because receipt indexing is behind", async (t) => {
  let sends = 0;
  const f = fixture(t, { async submit() { sends += 1; }, async lookupReceipt() { return unknownReceipt(); } });
  await f.outbox.submit("one");
  for (let index = 0; index < 5; index += 1) await f.outbox.reconcilePending();
  assert.equal(sends, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.row().deliveryConfirmed, true);
});

test("stop fences an in-flight receipt result and clears recovery timers", async (t) => {
  let sends = 0;
  let release;
  let reached;
  const ready = new Promise((resolve) => { reached = resolve; });
  const f = fixture(t, { async submit() { sends += 1; throw unknown(); }, async lookupReceipt() { reached(); return new Promise((resolve) => { release = resolve; }); } });
  await f.outbox.submit("one");
  const pending = f.tick();
  await ready;
  f.outbox.stop();
  release(unknownReceipt());
  await pending;
  assert.equal(sends, 1);
  assert.equal(f.row().state, "confirming");
  assert.equal(f.row().attempts, 0);
  assert.equal(f.timers.size, 0);
});

test("positive receipt settles the original command without any replay", async (t) => {
  let sends = 0;
  const f = fixture(t, { async submit() { sends += 1; throw unknown(); }, async lookupReceipt() { return receipt(); } });
  await f.outbox.submit("one"); await f.tick();
  assert.equal(sends, 1);
  assert.equal(f.row().state, "persisted");
  assert.equal(f.row().attempts, 0);
  assert.equal(f.timers.size, 0);
});

test("a denied replay cannot prove the original ambiguous send failed", async (t) => {
  let sends = 0;
  const f = fixture(t, {
    async submit() { if (++sends === 1) throw unknown(); throw Object.assign(new Error("permission changed"), { code: "COLLAB_AUTHORIZATION_DENIED" }); },
    async lookupReceipt() { return unknownReceipt(); },
  });
  await f.outbox.submit("one"); await f.tick();
  assert.equal(f.row().state, "delivery_unknown", "later authorization denial is not failure evidence for the earlier request");
  assert.equal(f.timers.size, 0);
  await f.outbox.reconcilePending();
  assert.equal(sends, 2);
});

for (const lateResult of ["success", "network failure"]) {
  test(`stop fences a recovery replay's late ${lateResult} and preserves restart state`, async (t) => {
    let sends = 0;
    let release;
    let reached;
    const ready = new Promise((resolve) => { reached = resolve; });
    const f = fixture(t, {
      async submit() {
        if (++sends === 1) throw unknown();
        reached();
        await new Promise((resolve) => { release = resolve; });
        if (lateResult === "network failure") throw offline();
      },
      async lookupReceipt() { return unknownReceipt(); },
    });
    await f.outbox.submit("one");
    const pending = f.tick();
    await ready;
    assert.equal(f.row().state, "confirming", "in-flight replay never erases durable ambiguity");
    assert.equal(f.row().attempts, 1, "attempt is durable before dispatch");
    f.outbox.stop(); release(); await pending;
    assert.equal(f.row().state, "confirming");
    assert.equal(f.row().deliveryConfirmed, false);
    assert.equal(f.timers.size, 0);
    f.restart();
    assert.equal(f.row().state, "confirming");
    assert.equal(f.row().attempts, 1);
    await f.outbox.reconcilePending();
    assert.equal(f.timers.size, 1, "restart schedules receipt recovery rather than losing or blindly sending the command");
    assert.equal(sends, 2);
  });
}

const incompleteReceipts = [
  ["missing receipt", undefined],
  ["null receipt", null],
  ["empty receipt", {}],
  ["partial committed receipt", { committed: true, eventId: "server-event" }],
  ["partial unknown receipt", { committed: false }],
  ["string committed flag", { ...receipt(), committed: "true" }],
  ["empty event ID", { ...receipt(), eventId: " " }],
  ["oversized event ID", { ...receipt(), eventId: "e".repeat(513) }],
  ["non-string message ID", { ...receipt(), messageId: {} }],
  ["oversized message ID", { ...receipt(), messageId: "m".repeat(513) }],
  ["oversized composite message key", { ...receipt(), messageId: "m".repeat(500) }],
  ["zero sequence", { ...receipt(), sequence: 0 }],
  ["non-integer sequence", { ...receipt(), sequence: 1.5 }],
  ["wrong unknown state", { ...unknownReceipt(), state: "pending" }],
  ["missing unknown marker", { state: "unknown", committed: false }],
  ["contradictory unknown receipt", { ...unknownReceipt(), eventId: "server-event" }],
  ["contradictory committed state", { ...receipt(), state: "unknown" }],
  ["pending unknown receipt", { ...unknownReceipt(), pending: true }],
  ["failed receipt envelope", { ...receipt(), ok: false }],
];

for (const [label, partial] of incompleteReceipts) {
  test(`${label} cannot authorize replay or claim delivery`, async (t) => {
    let sends = 0;
    const f = fixture(t, { async submit() { sends += 1; throw unknown(); }, async lookupReceipt() { return partial; } });
    f.add("two");
    await f.outbox.submit("one");
    await f.tick(); await f.tick(); await f.tick();
    assert.equal(sends, 1, "only a complete, explicit server unknown result permits same-key replay");
    assert.equal(f.row().state, "delivery_unknown", "malformed receipt requires a visible recovery decision");
    assert.equal(f.timers.size, 0);
    assert.equal((await f.outbox.submit("two")).blockedBy, "one");
    assert.ok(f.store.getMessage({ conversationId: "conversation", messageId: "local-one" }), "ambiguous optimistic history is retained");
  });
}

for (const action of ["skip", "cancel"]) {
  test(`manual continuation retains uncertainty through reopen and ${action}`, async (t) => {
    const f = fixture(t, { async submit() { throw unknown(); }, async lookupReceipt() { return unknownReceipt(); } });
    f.add("two");
    await f.outbox.submit("one"); await f.outbox.cancel("one");
    assert.equal(f.outbox.continue("one").state, "queued");
    f.restart();
    assert.equal(f.row().deliveryUncertain, true, "manual continuation cannot erase persisted dispatch uncertainty");
    assert.equal((await f.outbox[action]("one")).state, "delivery_unknown");
    assert.equal(f.row().state, "delivery_unknown");
    assert.equal((await f.outbox.submit("two")).blockedBy, "one");
    assert.equal(f.row().bodyText, "original body one");
  });

  test(`abandoned submitting remains uncertain after restart recovery and ${action}`, async (t) => {
    let release;
    let reached;
    const ready = new Promise((resolve) => { reached = resolve; });
    const f = fixture(t, { async submit() { reached(); await new Promise((resolve) => { release = resolve; }); }, async lookupReceipt() { return unknownReceipt(); } });
    f.add("two");
    const pending = f.outbox.submit("one"); await ready;
    f.outbox.stop(); release(); await pending;
    f.restart();
    assert.equal(f.row().state, "confirming", "startup reconciles an abandoned dispatch before any replay");
    assert.equal(f.row().deliveryUncertain, true);
    assert.equal((await f.outbox[action]("one")).state, action === "skip" ? "confirming" : "delivery_unknown");
    assert.equal((await f.outbox.submit("two")).blockedBy, "one");
  });

  test(`never-dispatched queued work can still ${action} normally`, async (t) => {
    const f = fixture(t, { async submit() { throw new Error("unexpected dispatch"); } });
    assert.equal(f.row().deliveryUncertain, false);
    assert.equal((await f.outbox[action]("one")).state, "cancelled");
    assert.equal(f.row().state, "cancelled");
  });

  test(`a successful ACK permits revocation but never false ${action}`, async (t) => {
    const f = fixture(t, { async submit() {}, async lookupReceipt() { return unknownReceipt(); } });
    await f.outbox.submit("one");
    assert.equal(f.row().deliveryUncertain, false);
    assert.equal(f.row().deliveryConfirmed, true);
    const result = await f.outbox[action]("one");
    assert.equal(result.state, "confirming");
    assert.equal(result.canRevoke, true);
    assert.equal(f.row().state, "confirming");
  });
}

test("known transport failure after manual unknown recovery cannot erase the original uncertainty", async (t) => {
  let sends = 0;
  const f = fixture(t, { async submit() { if (++sends === 1) throw unknown(); throw offline(); }, async lookupReceipt() { return unknownReceipt(); } }, { maxAutoRetries: 1 });
  await f.outbox.submit("one"); await f.tick();
  f.outbox.continue("one");
  await assert.rejects(f.outbox.submit("one"), /offline/);
  assert.equal(f.row().state, "delivery_unknown");
  assert.equal(f.row().deliveryUncertain, true);
  assert.equal(f.outbox.skip("one").state, "delivery_unknown");
});

test("a known pre-dispatch failure preserves ordinary queued cancellation", async (t) => {
  const f = fixture(t, { async submit() { throw offline(); } });
  await assert.rejects(f.outbox.submit("one"), /offline/);
  assert.equal(f.row().state, "queued");
  assert.equal(f.row().deliveryUncertain, false);
  assert.equal((await f.outbox.cancel("one")).state, "cancelled");
});

test("complete receipt clears durable uncertainty as positive delivery evidence", async (t) => {
  const f = fixture(t, { async submit() { throw unknown(); }, async lookupReceipt() { return receipt(); } });
  await f.outbox.submit("one");
  assert.equal(f.row().deliveryUncertain, true);
  await f.tick();
  assert.equal(f.row().state, "persisted");
  assert.equal(f.row().deliveryUncertain, false);
  assert.equal(f.row().deliveryConfirmed, true);
});

test("v7 migration conservatively retains legacy unresolved dispatch uncertainty", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-collab-unknown-upgrade-"));
  const db = openDatabase(path.join(dir, "legacy.db"));
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  db.migrate(COLLABORATION_MIGRATIONS.slice(0, 6));
  for (const state of ["queued", "submitting", "confirming", "cancellation_requested", "delivery_unknown", "paused", "failed", "persisted", "cancelled"]) {
    db.run(`INSERT INTO outbox(account_id,id,conversation_id,client_command_id,state,payload_envelope_json,created_at,updated_at)
      VALUES('alice',?,'conversation',?,?,'{}',1,1)`, state, state, state);
  }
  db.run("INSERT INTO outbox(account_id,id,conversation_id,client_command_id,state,payload_envelope_json,created_at,updated_at,delivery_confirmed) VALUES('alice','acked','conversation','acked','confirming','{}',1,1,1)");
  db.migrate(COLLABORATION_MIGRATIONS);
  const columns = db.all("PRAGMA table_info(outbox)");
  assert.ok(columns.some((column) => column.name === "delivery_uncertain"), "v7 adds durable uncertainty instead of inferring it from transient queue state");
  for (const row of db.all("SELECT id,state,delivery_uncertain FROM outbox")) {
    assert.equal(Number(row.delivery_uncertain), ["persisted", "cancelled", "acked"].includes(row.id) ? 0 : 1, row.id);
  }
});

test("crash after durable ACK but before confirming transition never redispatches on restart", async (t) => {
  let sends = 0;
  const f = fixture(t, { async submit() { sends += 1; }, async lookupReceipt() { return receipt(); } });
  f.store.setOutboxState({ outboxId: "one", expectedStates: ["queued"], state: "submitting" });
  f.store.confirmOutboxDelivery({ outboxId: "one" });
  assert.equal(f.row().state, "submitting");
  assert.equal(f.row().deliveryConfirmed, true);
  f.restart();
  assert.equal(f.row().state, "confirming", "durable ACK outranks abandoned submitting recovery");
  await f.outbox.drainQueued();
  assert.equal(sends, 0, "startup must only hydrate or look up the already acknowledged command");
  await f.outbox.reconcilePending();
  assert.equal(f.row().state, "persisted");
});

test("submit itself refuses to resend ACK-backed queued work", async (t) => {
  let sends = 0;
  const f = fixture(t, { async submit() { sends += 1; } });
  f.store.confirmOutboxDelivery({ outboxId: "one" });
  assert.equal(f.row().state, "queued", "simulate an older recovery path returning ACK-backed work to queued");
  assert.equal((await f.outbox.submit("one")).state, "confirming");
  assert.equal(sends, 0, "the send boundary must independently honor positive delivery evidence");
  assert.equal(f.row().state, "confirming");
  assert.equal(f.row().deliveryConfirmed, true);
});

test("abandoned dispatch recovery is receipt-first and restart cannot replenish replay budget", async (t) => {
  let sends = 0, lookups = 0;
  const f = fixture(t, { async submit() { sends++; throw unknown(); }, async lookupReceipt() { lookups++; return unknownReceipt(); } });
  f.store.setOutboxState({ outboxId: "one", expectedStates: ["queued"], state: "submitting" });
  for (let i = 0; i < 5; i++) {
    f.restart();
    const before = sends; await f.outbox.drainQueued();
    assert.equal(sends, before, "startup drain never blindly dispatches abandoned uncertain work");
    await f.outbox.reconcilePending();
    if (f.timers.size) await f.tick();
  }
  assert.equal(lookups >= 3, true); assert.equal(sends, 2, "only the two budgeted replays after the abandoned initial dispatch are allowed");
  assert.equal(f.row().state, "delivery_unknown"); assert.equal(f.row().attempts, 3);
});

test("receipt projection failure retains an automatic recovery timer without replaying", async (t) => {
  let sends = 0;
  const f = fixture(t, { async submit() { sends += 1; throw unknown(); }, async lookupReceipt() { return receipt(); } });
  await f.outbox.submit("one");
  const encrypt = f.store.keyring.encrypt;
  f.store.keyring.encrypt = () => { throw new Error("transient keyring encryption failure"); };
  await f.tick();
  assert.equal(f.row().state, "confirming");
  assert.equal(f.timers.size, 1, "a failed local projection must not silently lose the next receipt check");
  assert.equal(sends, 1);
  f.store.keyring.encrypt = encrypt;
  await f.tick();
  assert.equal(f.row().state, "persisted");
  assert.equal(sends, 1);
});

test("cancel receipt projection failure returns recoverable unknown rather than stranding cancellation", async (t) => {
  const f = fixture(t, { async submit() { throw unknown(); }, async lookupReceipt() { return receipt(); } });
  await f.outbox.submit("one");
  const encrypt = f.store.keyring.encrypt;
  f.store.keyring.encrypt = () => { throw new Error("transient keyring encryption failure"); };
  assert.equal((await f.outbox.cancel("one")).state, "delivery_unknown");
  assert.equal(f.row().state, "delivery_unknown");
  f.store.keyring.encrypt = encrypt;
  await f.outbox.reconcilePending();
  assert.equal(f.row().state, "persisted");
});

test("ACK-backed projection failure still schedules receipt-only recovery", async (t) => {
  let sends = 0;
  const f = fixture(t, { async submit() { sends += 1; }, async lookupReceipt() { return receipt(); } });
  await f.outbox.submit("one");
  const encrypt = f.store.keyring.encrypt;
  f.store.keyring.encrypt = () => { throw new Error("transient keyring encryption failure"); };
  await f.outbox.reconcilePending();
  assert.equal(f.row().deliveryConfirmed, true);
  assert.equal(f.timers.size, 1, "an ACK does not make local projection errors disappear");
  f.store.keyring.encrypt = encrypt;
  await f.tick();
  assert.equal(f.row().state, "persisted");
  assert.equal(sends, 1);
});

for (const action of ["reconcile", "cancel"]) test(`complete receipt evidence survives ${action} projection failure and later unknown`, async (t) => {
  let sends = 0, lookupResult = receipt();
  const f = fixture(t, { async submit() { sends++; throw unknown(); }, async lookupReceipt() { return lookupResult; } });
  await f.outbox.submit("one");
  const encrypt = f.store.keyring.encrypt;
  f.store.keyring.encrypt = () => { throw new Error("projection failed"); };
  if (action === "cancel") await f.outbox.cancel("one"); else await f.tick();
  assert.equal(f.row().deliveryConfirmed, true, "server commit evidence is independent of body projection");
  f.store.keyring.encrypt = encrypt; lookupResult = unknownReceipt();
  if (action === "cancel") { f.outbox.continue("one"); await f.outbox.submit("one"); }
  if (f.timers.size) await f.tick();
  await f.outbox.reconcilePending();
  assert.equal(sends, 1, "later unknown cannot erase the positive receipt and resend");
});

test("skip cannot hide delivery_unknown or release its ordering barrier", async (t) => {
  let sends = 0;
  const f = fixture(t, { async submit() { sends += 1; throw unknown(); }, async lookupReceipt() { return unknownReceipt(); } }, { maxAutoRetries: 1 });
  f.add("two");
  await f.outbox.submit("one"); await f.tick();
  assert.equal(f.row().state, "delivery_unknown");
  assert.equal(f.outbox.skip("one").state, "delivery_unknown", "skip is not evidence that the original message was cancelled");
  assert.equal(f.row().state, "delivery_unknown");
  await f.outbox.drainQueued();
  assert.equal(sends, 1);
  assert.equal((await f.outbox.submit("two")).blockedBy, "one");
  assert.equal(f.row().bodyText, "original body one");
});

for (const [label, partial] of incompleteReceipts) {
  test(`cancel with ${label} preserves unknown delivery and the optimistic message`, async (t) => {
    let sends = 0;
    let lookupResult = partial;
    const f = fixture(t, { async submit() { sends += 1; throw unknown(); }, async lookupReceipt() { return lookupResult; } });
    f.add("two");
    await f.outbox.submit("one");
    const cancelled = await f.outbox.cancel("one");
    assert.equal(cancelled.state, "delivery_unknown");
    assert.equal(cancelled.canRevoke, undefined, "incomplete evidence cannot advertise an authoritative sent message");
    assert.equal(f.row().state, "delivery_unknown");
    assert.ok(f.store.getMessage({ conversationId: "conversation", messageId: "local-one" }));
    while (f.timers.size) await f.tick();
    assert.equal(sends, 1, "cancelled unknown must remain receipt-only");
    assert.equal((await f.outbox.submit("two")).blockedBy, "one");
    lookupResult = receipt();
    await f.outbox.reconcilePending();
    assert.equal(f.row().state, "persisted", "later complete receipt still settles the exact original command");
    assert.equal(f.store.getMessage({ conversationId: "conversation", messageId: "server-one" }).seq, 1);
    assert.equal(f.store.countMessages({ conversationId: "conversation" }), 2);
  });
}
