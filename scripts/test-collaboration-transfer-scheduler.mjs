import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createTransferManifestStore } = require("../src/main/collaboration/transfer-manifest");
const { LocalCollaborationKeyring } = require("../src/main/collaboration/local-keyring");
const { createTransferManager } = require("../src/main/collaboration/transfer-manager");
let createTransferScheduler;
try { ({ createTransferScheduler } = require("../src/main/collaboration/transfer-scheduler")); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }

function fixture(t) {
  assert.equal(typeof createTransferScheduler, "function", "durable consent and retry scheduling are required");
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "collab-scheduler-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "file.txt"); fs.writeFileSync(source, "result");
  const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, "keys"), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
  } });
  const manifests = createTransferManifestStore({ rootPath: path.join(dir, "collaboration-transfer"), accountId: "alice", keyring });
  const state = { now: 10000, calls: [], hold: null, authorized: true };
  const objectClient = { async init(input) {
    state.calls.push(input.clientCommandId);
    const item = manifests.scan().transfers.find((entry) => entry.commandIds.init === input.clientCommandId);
    assert.equal(item.checkpoint.schedule.enabled, true, "user consent is durable before transport");
    assert.ok(item.checkpoint.schedule.attempts >= 1, "attempt budget is durable before transport");
    if (state.hold) await state.hold(input);
    throw Object.assign(new Error("private URL must not escape"), { code: "COLLAB_RESPONSE_UNKNOWN", retryable: true });
  } };
  const options = { manifests, objectClient, multipart: {}, deviceId: "device", assertAuthorized: () => state.authorized };
  const create = (schedulerOptions = {}) => {
    const manager = createTransferManager(options);
    const scheduler = createTransferScheduler({ manager, manifests, now: () => state.now, ...schedulerOptions });
    t.after(() => scheduler.stop());
    return { manager, scheduler };
  };
  const prepare = (manager) => manager.prepareUpload({ inputPath: source, conversationId: "conversation", scopeId: "personal", originalName: "file.txt" });
  return { manifests, state, create, prepare };
}

test("prepared transfers require explicit enqueue; restart respects persistent retry deadline and identity", async (t) => {
  const f = fixture(t), first = f.create(), item = await f.prepare(first.manager);
  await first.scheduler.tick();
  assert.equal(f.state.calls.length, 0, "scanning private prepared files never uploads them");
  first.scheduler.enqueue(item.id); await first.scheduler.tick();
  assert.equal(f.state.calls.length, 1);
  const checkpoint = f.manifests.read(item.id).checkpoint;
  assert.equal(checkpoint.schedule.attempts, 1);
  assert.ok(checkpoint.schedule.nextAttemptAt > f.state.now);
  first.scheduler.stop();
  const second = f.create();
  await second.scheduler.tick(); assert.equal(f.state.calls.length, 1);
  f.state.now = checkpoint.schedule.nextAttemptAt;
  await second.scheduler.tick(); assert.equal(f.state.calls.length, 2);
  assert.equal(f.state.calls[0], f.state.calls[1]);
  assert.doesNotMatch(JSON.stringify(second.scheduler.list()), /private URL|dek|deviceId|inputPath/);
});

test("automatic attempts are bounded across restart; explicit continuation retains the original command", async (t) => {
  const f = fixture(t), { manager, scheduler } = f.create(), item = await f.prepare(manager);
  scheduler.enqueue(item.id);
  for (let i = 0; i < 3; i++) { await scheduler.tick(); f.state.now += 100000; }
  assert.equal(f.state.calls.length, 3);
  assert.equal(f.manifests.read(item.id).checkpoint.schedule.enabled, false);
  scheduler.stop();
  const next = f.create(); await next.scheduler.tick(); assert.equal(f.state.calls.length, 3);
  next.scheduler.enqueue(item.id); await next.scheduler.tick();
  assert.equal(f.state.calls.length, 4);
  assert.equal(new Set(f.state.calls).size, 1);
});

test("one slow transfer cannot serialize another; repeated enqueue cannot reset its active budget", async (t) => {
  const f = fixture(t), { manager, scheduler } = f.create(), a = await f.prepare(manager), b = await f.prepare(manager);
  const aCommand = f.manifests.read(a.id).commandIds.init;
  let release;
  f.state.hold = (input) => input.clientCommandId === aCommand ? new Promise((resolve) => { release = resolve; }) : undefined;
  scheduler.enqueue(a.id); scheduler.enqueue(b.id);
  const running = scheduler.tick();
  while (!release || f.state.calls.length < 2) await new Promise(setImmediate);
  scheduler.enqueue(a.id);
  assert.equal(f.manifests.read(a.id).checkpoint.schedule.attempts, 1);
  release(); await running;
  assert.equal(f.state.calls.length, 2);
});

test("pause fences late completion and remains paused after restart until explicit continuation", async (t) => {
  const f = fixture(t), { manager, scheduler } = f.create(), item = await f.prepare(manager);
  let release; f.state.hold = () => new Promise((resolve) => { release = resolve; });
  scheduler.enqueue(item.id); const running = scheduler.tick();
  while (!release) await new Promise(setImmediate);
  scheduler.pause(item.id);
  const paused = f.manifests.read(item.id);
  release(); await running;
  assert.deepEqual(f.manifests.read(item.id), paused, "a late network failure cannot re-enable user-paused work");
  scheduler.stop();
  f.state.now += 100000; await f.create().scheduler.tick();
  assert.equal(f.state.calls.length, 1);
});

test("stop and revocation fence scheduler writes and never expose a previous scope", async (t) => {
  const f = fixture(t), { manager, scheduler } = f.create(), item = await f.prepare(manager);
  let release; f.state.hold = () => new Promise((resolve) => { release = resolve; });
  scheduler.enqueue(item.id); const running = scheduler.tick();
  while (!release) await new Promise(setImmediate);
  const before = f.manifests.read(item.id);
  scheduler.stop(); release(); await running;
  assert.deepEqual(f.manifests.read(item.id), before);
  assert.deepEqual(scheduler.list().transfers, []);
  const next = f.create(); f.state.authorized = false; f.state.now += 100000;
  await next.scheduler.tick();
  assert.deepEqual(next.scheduler.list().transfers, []);
  assert.equal(f.state.calls.length, 1);
});

test("a user can cancel a paused transfer without re-enabling network work", async (t) => {
  const f = fixture(t), { manager, scheduler } = f.create(), item = await f.prepare(manager);
  scheduler.pause(item.id);
  assert.equal((await scheduler.cancel(item.id)).state, "cancelled");
  scheduler.enqueue(item.id); await scheduler.tick();
  assert.equal(f.state.calls.length, 0);
  assert.equal(scheduler.list().transfers[0].state, "cancelled");
});

test("a pause on the reserved-attempt notification wins before the first dispatch", async (t) => {
  const f = fixture(t);
  let id, paused = false;
  const { manager, scheduler } = f.create({ onChange() {
    if (!id || paused || f.manifests.read(id).checkpoint.schedule?.attempts !== 1) return;
    paused = true; scheduler.pause(id);
  } });
  id = (await f.prepare(manager)).id;
  scheduler.enqueue(id); await scheduler.tick();
  assert.equal(paused, true);
  assert.equal(f.state.calls.length, 0, "publishing progress must not bypass a newer user pause");
  assert.equal(f.manifests.read(id).checkpoint.schedule.enabled, false);
});

test("lifecycle timers are unique and stopped ticks cannot revive queued work", async (t) => {
  const f = fixture(t);
  let timerCallback, scheduled = 0, cleared = 0;
  const handle = {};
  const { manager, scheduler } = f.create({
    setIntervalImpl(callback, milliseconds) { assert.equal(milliseconds, 1000); timerCallback = callback; scheduled++; return handle; },
    clearIntervalImpl(value) { assert.equal(value, handle); cleared++; },
  });
  const item = await f.prepare(manager);
  scheduler.start(); scheduler.start(); await scheduler.tick();
  assert.equal(scheduled, 1); assert.equal(f.state.calls.length, 0);
  scheduler.enqueue(item.id); await scheduler.tick();
  assert.equal(f.state.calls.length, 1);
  scheduler.stop(); scheduler.stop(); scheduler.start();
  timerCallback(); await scheduler.tick();
  assert.equal(cleared, 1); assert.equal(scheduled, 1); assert.equal(f.state.calls.length, 1);
});

test("pause is durable in one write even if the process exits before scheduler bookkeeping", async (t) => {
  const f = fixture(t), { manager, scheduler } = f.create(), item = await f.prepare(manager);
  scheduler.enqueue(item.id); await scheduler.tick();
  manager.pause(item.id); // Crash boundary inside scheduler.pause, after its manager call.
  scheduler.stop(); f.state.now += 100000;
  assert.equal(f.manifests.read(item.id).checkpoint.schedule.enabled, false, "paused state and disabled scheduling must be one atomic checkpoint");
  await f.create().scheduler.tick();
  assert.equal(f.state.calls.length, 1);
});

test("download retries use download authorization, never the uploader's init command", async (t) => {
  const f = fixture(t);
  // A missing ticket endpoint is a terminal failure; it must not fall back to
  // initializing an upload or sharing the text-message delivery lane.
  const { manager, scheduler } = f.create();
  const item = manager.prepareDownload({ objectId: "object", conversationId: "conversation", scopeId: "personal" });
  scheduler.enqueue(item.id); await scheduler.tick();
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.manifests.read(item.id).checkpoint.schedule.enabled, false);
  assert.equal(scheduler.list().transfers[0].state, "failed");
});
