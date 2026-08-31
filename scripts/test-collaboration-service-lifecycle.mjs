import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { CollaborationStore } = require("../src/main/collaboration/collaboration-store.js");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring.js");
const { createCollaborationClient } = require("../src/main/collaboration/client.js");
const { createCollaborationService } = require("../src/main/collaboration/service.js");
const { createCollaborationOutbox } = require("../src/main/collaboration/outbox.js");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const stopped = { ok: false, code: "COLLABORATION_STOPPED" };
const snapshot = { watermark: 4, conversations: [{ id: "c1", kind: "direct" }], bootstrapCompletionToken: "token-4" };

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "collab-lifecycle-"));
  const dbPath = path.join(dir, "cache.db");
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys.json"), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
  } });
  const reopen = () => new CollaborationStore({ dbPath, accountId: "alice", keyring });
  const raw = reopen();
  raw.replaceProjectionFromBootstrap({ ...snapshot, watermark: 0 });
  const log = [];
  let closed = false;
  const store = new Proxy(raw, { get(target, key) {
    const value = target[key];
    if (typeof value !== "function") return value;
    return (...args) => {
      log.push(String(key));
      assert.equal(closed, false, `no ${String(key)} after SQLite closes`);
      if (key === "close") closed = true;
      return value.apply(target, args);
    };
  } });
  t.after(() => { if (!closed) store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, log, reopen };
}

function network(request) {
  return createCollaborationClient({
    accountManager: { accessTokenForService: async () => ({ ok: true, accessToken: "test-only" }) },
    signDeviceRequest: async () => ({}),
    request: async (input) => ({ ok: true, status: 200, json: await request(input) }),
  });
}

test("bootstrap, incremental sync, and open history share one commit/ACK lane", async (t) => {
  const f = fixture(t);
  const releasePage = deferred();
  const order = [];
  const client = network(async ({ path: route, body }) => {
    if (route.endsWith("/sync")) {
      order.push("sync");
      await releasePage.promise;
      return { fromCursor: body.afterCursor, toCursor: body.afterCursor, events: [] };
    }
    if (route.endsWith("/bootstrap")) { order.push("bootstrap"); return snapshot; }
    if (route.endsWith("/messages")) { order.push("history"); return { result: [] }; }
    order.push(`ack:${body.cursor}`);
    return {};
  });
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), client, deviceId: "d" });
  const sync = service.realtime.notifyAvailable();
  await tick();
  const boot = service.bootstrap();
  const open = service.open({ conversationId: "c1" });
  await tick();
  const whileSyncPending = [...order];
  releasePage.resolve();
  await Promise.all([sync, boot, open]);
  assert.deepEqual(whileSyncPending, ["sync"], "neither bootstrap nor history may overtake an in-flight page");
  assert.deepEqual(order, ["sync", "ack:0", "bootstrap", "history", "ack:4", "history"]);
  assert.equal(service.getState().cursor, 4, "a delayed earlier page cannot roll the bootstrap cursor backward");
  service.stop();
});

for (const phase of ["sync", "bootstrap", "history", "ack"]) {
  for (const rejects of [false, true]) {
    test(`stop fences late ${phase} ${rejects ? "failure" : "success"} without DB writes, new ACKs, or emissions`, async (t) => {
      const f = fixture(t);
      const pending = deferred();
      const reached = deferred();
      const calls = [];
      const client = network(async ({ path: route, body }) => {
        const name = route.split("/").at(-1) === "messages" ? "history" : route.split("/").at(-1);
        calls.push(name);
        if (name === phase) { reached.resolve(); await pending.promise; }
        if (name === "bootstrap") return snapshot;
        if (name === "sync") return { fromCursor: body.afterCursor, toCursor: body.afterCursor, events: [] };
        if (name === "history") return { result: [] };
        return {};
      });
      const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), client, deviceId: "d" });
      const emissions = [];
      service.subscribe((event) => emissions.push(event));
      const run = phase === "sync" ? service.realtime.notifyAvailable() : service.bootstrap();
      const outcome = Promise.resolve(run).catch((error) => ({ code: error.code }));
      await reached.promise;
      service.stop();
      const accessesAtStop = f.log.length;
      const callsAtStop = calls.length;
      if (rejects) pending.reject(new Error("late network failure")); else pending.resolve();
      await outcome;
      await tick();
      assert.equal(f.log.length, accessesAtStop, "late work must not even read the closed database");
      assert.equal(calls.length, callsAtStop, "late work cannot issue history or ACK calls");
      assert.deepEqual(emissions, []);
      assert.doesNotThrow(() => service.stop(), "stop is idempotent");
      assert.equal(f.log.filter((name) => name === "close").length, 1);
    });
  }
}

test("stopped service rejects every new operation without reaching storage or network", async (t) => {
  const f = fixture(t);
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), deviceId: "d",
    client: network(() => { throw new Error("network after stop"); }), transport: { submit() { throw new Error("send after stop"); } },
  });
  service.stop();
  for (const method of ["getState", "list", "getDraft", "saveDraft", "readMessages", "open", "bootstrap", "send", "edit", "revoke", "friend", "retry", "cancel", "markRead", "start"]) {
    assert.deepEqual(await service[method]({ conversationId: "c1", seq: 1 }), stopped, method);
  }
  await service.realtime.notifyAvailable();
  assert.deepEqual(f.log, ["close"]);
});

for (const rejects of [false, true]) {
  test(`outbox stop preserves in-flight same-key recovery on late ${rejects ? "retryable failure" : "success"}`, async (t) => {
    const f = fixture(t);
    f.store.persistDraftAndOptimisticMessage({ conversationId: "c1", messageId: "local-1", clientCommandId: "key-1", draftId: "composer", draftText: "", bodyText: "body" });
    const pending = deferred();
    const reached = deferred();
    const emissions = [];
    const timers = [];
    const outbox = createCollaborationOutbox({ store: f.store, onStateChange: (event) => emissions.push(event),
      setTimeoutFn: (...args) => { timers.push(args); return timers.length; },
      transport: { submit: async () => { reached.resolve(); await pending.promise; } },
    });
    const run = outbox.submit("key-1").catch((error) => ({ code: error.code }));
    await reached.promise;
    outbox.stop();
    f.store.close();
    const accessesAtStop = f.log.length;
    if (rejects) pending.reject(Object.assign(new Error("offline"), { code: "COLLAB_NETWORK_UNAVAILABLE" })); else pending.resolve();
    assert.deepEqual(await run, stopped);
    assert.equal(f.log.length, accessesAtStop);
    assert.deepEqual(emissions, []);
    assert.deepEqual(timers, [], "late transport failure cannot revive retry timers");
    for (const method of ["submit", "continue", "skip", "cancel", "reconcilePending", "drainQueued"]) {
      assert.deepEqual(await outbox[method]("key-1"), stopped, method);
    }
    const recovered = f.reopen();
    try {
      assert.equal(recovered.getOutbox({ outboxId: "key-1" }).state, "submitting");
      recovered.recoverAbandonedSubmittingOutbox();
      const row = recovered.getOutbox({ outboxId: "key-1" });
      assert.equal(row.state, "confirming", "restart retains same-key receipt-first recovery without blind replay");
      assert.equal(row.clientCommandId, "key-1");
    } finally { recovered.close(); }
  });
}

for (const operation of ["cancel", "reconcilePending"]) {
  test(`stop fences a pending ${operation} receipt and queued conversation work`, async (t) => {
    const f = fixture(t);
    f.store.persistDraftAndOptimisticMessage({ conversationId: "c1", messageId: "local-1", clientCommandId: "key-1", draftId: "composer", draftText: "", bodyText: "body" });
    f.store.setOutboxState({ outboxId: "key-1", expectedStates: ["queued"], state: "confirming" });
    const pending = deferred();
    const reached = deferred();
    const outbox = createCollaborationOutbox({ store: f.store, transport: {
      submit: async () => {}, lookupReceipt: async () => { reached.resolve(); return pending.promise; },
    } });
    const run = outbox[operation]("key-1").catch((error) => ({ code: error.code }));
    await reached.promise;
    const queued = outbox.cancel("key-1").catch((error) => ({ code: error.code }));
    outbox.stop();
    f.store.close();
    const accessesAtStop = f.log.length;
    pending.resolve({ committed: true, eventId: "e1", messageId: "m1", sequence: 1 });
    await run;
    assert.deepEqual(await queued, stopped);
    assert.equal(f.log.length, accessesAtStop);
  });
}

for (const phase of ["token", "sign", "401"]) {
  test(`stop prevents a new ACK request after the client's ${phase} await`, async (t) => {
    const f = fixture(t);
    const pending = deferred();
    const reached = deferred();
    const requests = [];
    let tokenCalls = 0;
    const client = createCollaborationClient({
      accountManager: { async accessTokenForService() {
        tokenCalls += 1;
        if (phase === "token" && tokenCalls === 2) { reached.resolve(); await pending.promise; }
        return { ok: true, accessToken: "test-only" };
      } },
      async signDeviceRequest({ path: route }) {
        if (phase === "sign" && route.endsWith("/ack")) { reached.resolve(); await pending.promise; }
        return {};
      },
      async request({ path: route }) {
        requests.push(route);
        if (route.endsWith("/bootstrap")) return { ok: true, status: 200, json: { ...snapshot, conversations: [] } };
        if (phase === "401" && requests.length === 2) { reached.resolve(); await pending.promise; return { ok: false, status: 401 }; }
        return { ok: true, status: 200, json: {} };
      },
    });
    const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), client, deviceId: "d" });
    const run = service.bootstrap().catch((error) => ({ code: error.code }));
    await reached.promise;
    service.stop();
    const sentAtStop = requests.length;
    pending.resolve();
    await run;
    assert.equal(requests.length, sentAtStop, "no signing/token continuation or 401 retry may issue a post-stop ACK");
  });
}

test("a pending open cannot read cached messages after a late offline response", async (t) => {
  const f = fixture(t);
  const pending = deferred();
  const reached = deferred();
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), deviceId: "d", client: {
    async listMessageHistory() { reached.resolve(); return pending.promise; },
  } });
  const run = service.open({ conversationId: "c1" });
  await reached.promise;
  service.stop();
  const accessesAtStop = f.log.length;
  pending.reject(Object.assign(new Error("offline"), { code: "COLLAB_NETWORK_UNAVAILABLE" }));
  assert.deepEqual(await run, stopped);
  assert.equal(f.log.length, accessesAtStop);
});

test("service startup queries a crashed dispatch receipt before considering queued sends", async (t) => {
  const f = fixture(t), calls = [];
  f.store.persistDraftAndOptimisticMessage({ conversationId: "c1", messageId: "local", clientCommandId: "key", draftId: "composer", draftText: "", bodyText: "original" });
  f.store.setOutboxState({ outboxId: "key", expectedStates: ["queued"], state: "submitting" });
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), transport: {
    async submit() { calls.push("send"); }, async lookupReceipt() { calls.push("receipt"); return { committed: true, eventId: "e", messageId: "server", sequence: 1 }; },
  }, realtimeEnabled: false });
  service.start(); await tick(); await tick();
  assert.deepEqual(calls, ["receipt"]);
  assert.equal(f.store.getOutbox({ outboxId: "key" }).state, "persisted");
  service.stop();
});

for (const method of ["edit", "revoke", "friend", "markRead"]) {
  test(`late ${method} result never emits or starts another sync`, async (t) => {
    const f = fixture(t);
    f.store.persistDraftAndOptimisticMessage({ conversationId: "c1", messageId: "m1", clientCommandId: "key-1", draftId: "composer", draftText: "", bodyText: "body" });
    f.store.settleOutboxFromSync({ clientCommandId: "key-1", eventId: "event-key-1", messageId: "m1", sequence: 1 });
    const pending = deferred();
    const reached = deferred();
    const emissions = [];
    let syncCalls = 0;
    const submit = async () => { reached.resolve(); return pending.promise; };
    const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), deviceId: "d", transport: { submit }, client: {
      submitMessage: submit, submitFriend: submit, async syncAndAcknowledge() { syncCalls += 1; },
    } });
    service.subscribe((event) => emissions.push(event));
    const run = service[method](method === "friend" ? { action: "request", lilyId: "bob-exact", clientCommandId: "mutation" }
      : method === "edit" ? { conversationId: "c1", messageId: "m1", clientCommandId: "mutation", expectedRevision: 1, bodyText: "edited" }
        : method === "revoke" ? { conversationId: "c1", messageId: "m1", clientCommandId: "mutation", expectedRevision: 1 }
          : { conversationId: "c1", messageId: "m1", clientCommandId: "mutation", seq: 1 });
    await reached.promise;
    service.stop();
    const accessesAtStop = f.log.length;
    pending.resolve({});
    assert.deepEqual(await run, stopped);
    await tick();
    assert.equal(f.log.length, accessesAtStop);
    assert.equal(syncCalls, 0);
    assert.deepEqual(emissions, []);
  });
}

test("startup fire-and-forget failures terminate even when shutdown overtakes them", async (t) => {
  const f = fixture(t);
  const pending = deferred();
  const reached = deferred();
  let bootstrapCalls = 0;
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), deviceId: "d", realtimeEnabled: false, client: {
    async syncAndAcknowledge() { reached.resolve(); return pending.promise; },
    async bootstrap() { bootstrapCalls += 1; return snapshot; },
  } });
  service.start();
  await reached.promise;
  const boot = service.bootstrap();
  service.stop();
  const accessesAtStop = f.log.length;
  pending.reject(new Error("late background sync failure"));
  await boot;
  await tick();
  assert.equal(f.log.length, accessesAtStop);
  assert.equal(bootstrapCalls, 0, "shutdown rejects already-queued bootstrap work before its network request");
  // node:test also fails this test if the background rejection is unhandled.
});

test("repeated start cannot recover or replay this service's active submitting command", async (t) => {
  const f = fixture(t);
  const pending = deferred();
  const reached = deferred();
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), transport: {
    async submit() { reached.resolve(); return pending.promise; },
  } });
  service.start();
  const run = service.send({ conversationId: "c1", clientCommandId: "live-key", bodyText: "body" });
  await reached.promise;
  service.start();
  const stateAfterSecondStart = f.store.getOutbox({ outboxId: "live-key" }).state;
  const recoveryCalls = f.log.filter((name) => name === "recoverAbandonedSubmittingOutbox").length;
  service.stop();
  pending.resolve();
  await run;
  assert.equal(stateAfterSecondStart, "submitting", "restart recovery is only for abandoned prior-instance work");
  assert.equal(recoveryCalls, 1);
});

test("service retry stopped during uncertain mutation receipt returns stopped without replay", async (t) => {
  const f = fixture(t);
  f.store.persistDraftAndOptimisticMessage({ conversationId: "c1", messageId: "m-retry", clientCommandId: "seed-retry", draftId: "composer", draftText: "", bodyText: "body" });
  f.store.settleOutboxFromSync({ clientCommandId: "seed-retry", eventId: "seed-retry-event", messageId: "m-retry", sequence: 1 });
  f.store.persistMessageMutation({ commandType: "message.edit", conversationId: "c1", messageId: "m-retry", clientCommandId: "retry-mutation", expectedRevision: 1, bodyText: "after", originDeviceId: "d" });
  f.store.setOutboxState({ outboxId: "retry-mutation", expectedStates: ["queued"], state: "delivery_unknown" });
  const pending = deferred(), reached = deferred(); let submits = 0;
  const service = createCollaborationService({ openStore: () => ({ ok: true, store: f.store }), deviceId: "d", transport: {
    async submit() { submits += 1; }, async lookupReceipt() { reached.resolve(); return pending.promise; },
  } });
  const retry = service.retry({ outboxId: "retry-mutation" });
  await reached.promise; service.stop(); pending.reject(new Error("late receipt failure"));
  assert.deepEqual(await retry, stopped);
  assert.equal(submits, 0, "a stopped service never replays after an uncertain receipt failure");
});
