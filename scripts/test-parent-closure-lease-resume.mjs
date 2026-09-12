import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MessageStore } = require('../src/main/store/message-store');
const methods = require('../src/main/session-parent-closure-recovery');
const { createParentClosureRecoveryRuntime } = require('../src/main/parent-closure-recovery-runtime');
const { createTurnQueueLifecycleMethods } = require('../src/main/turn-queue-lifecycle');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-lease-'));
let now = 10000;
const realNow = Date.now;
Date.now = () => now;
let store = new MessageStore(path.join(root, 'messages.db'), path.join(root, 'blobs'));
let ownerScope = 'account:lease', session = { id: 's' };
const timers = new Set(), sent = [];
const manager = Object.assign({ _find: () => session, resolveTurnOwnerScope: () => ({ ownerScope }), _ensureImported() {}, _store: () => store,
  getTurnInputByTurnId: () => null }, methods);
const identity = { sessionId: 's', ownerScope, sourceTurnId: 'source', recoveryKey: 'parent-closure:s:source' };
const admitSource = id => store.admitTurnInput('s', { turnId: id, delivery: 'direct', status: 'completed', userText: 'Finish and test', files: [], metadata: {}, createdAt: now }, { ownerScope });
admitSource('source');
store.prepareParentClosureRecovery({ ...identity, now, source: { objective: 'Finish and test', taskContract: { active: true, taskType: 'code_change' }, evidence: { done: [{ id: 't', name: 'read', status: 'done' }] } } });
store.claimParentClosureRecovery({ ...identity, now });
store.close(); store = new MessageStore(path.join(root, 'messages.db'), path.join(root, 'blobs'));
const runtime = createParentClosureRecoveryRuntime({ ctx: { sessionManager: manager }, now: () => now,
  setTimeout: (fn, ms) => { const timer = { fn, at: now + ms }; timers.add(timer); return timer; }, clearTimeout: timer => timers.delete(timer),
  sendUserMessage: async (...args) => {
    store.admitTurnInput('s', { turnId: args[3].turnId, delivery: 'direct', status: 'admitted', userText: args[1], files: [], metadata: {}, createdAt: now }, { ownerScope });
    sent.push(args); return { ok: true, turnId: args[3].turnId };
  } });
try {
  await runtime.resumePendingParentClosures('s');
  assert.equal(sent.length, 0, 'unexpired claim cannot send');
  assert.equal(timers.size, 1, 'restart arms the future lease instead of forgetting it');
  const timer = [...timers][0];
  now = timer.at;
  timers.delete(timer); await timer.fn();
  assert.equal(sent.length, 1, 'one continuation after authoritative expiry');
  await runtime.resumePendingParentClosures('s');
  assert.equal(sent.length, 1);
  // Reuse the real reopened database for distinct crash-window scenarios.
  const seed = (id) => {
    now += 1; // A fresh user request follows the preceding cancellation epoch.
    admitSource(id);
    const value = { ...identity, sourceTurnId: id, recoveryKey: `parent-closure:s:${id}` };
    store.prepareParentClosureRecovery({ ...value, now, source: { objective: 'Finish and test', taskContract: { active: true, taskType: 'code_change' }, evidence: { done: [{ id: 't', name: 'read', status: 'done' }] } } });
    return store.claimParentClosureRecovery({ ...value, now }).recovery;
  };
  const fire = async timer => { timers.delete(timer); now = timer.at; await timer.fn(); };
  for (const scenario of ['owner', 'deleted', 'cancel', 'interrupted']) {
    const row = seed(scenario);
    await runtime.resumePendingParentClosures('s');
    assert.equal(timers.size, 1);
    const pending = [...timers][0];
    if (scenario === 'owner') ownerScope = 'account:other';
    if (scenario === 'deleted') session = null;
    if (scenario === 'cancel') {
      createTurnQueueLifecycleMethods({ log: console }).interrupt.call({
        _state: () => ({ phase: 'idle' }), turnRecoveryRuntime: runtime,
        ctx: { runnerPool: { get: () => null } },
      }, 's', { clearQueue: false });
      assert.equal(store.getParentClosureRecovery('s', scenario, ownerScope).reason, 'USER_INTERRUPTED');
    }
    if (scenario === 'interrupted') manager.getTurnInputByTurnId = (_s, id) => id === row.sourceTurnId ? { status: 'interrupted' } : null;
    await fire(pending);
    assert.equal(sent.length, 1, `${scenario} fences even an already queued callback`);
    ownerScope = identity.ownerScope; session = { id: 's' };
    manager.cancelPendingParentClosureRecoveries('s');
    manager.getTurnInputByTurnId = () => null;
  }
  const admitted = seed('admission');
  assert.equal(manager.reserveTaskContinuation('s', { sourceTurnId: 'admission', continuationTurnId: admitted.recoveryTurnId, now }).ok, true);
  store.admitTurnInput('s', { turnId: admitted.recoveryTurnId, delivery: 'direct', status: 'admitted', userText: 'Finish and test', files: [], metadata: {}, createdAt: now }, { ownerScope });
  manager.getTurnInputByTurnId = (_s, id) => store.getTurnInputByTurnId(id, ownerScope);
  const mark = manager.markParentClosureRecoveryDispatched;
  manager.markParentClosureRecoveryDispatched = () => { throw new Error('controlled late mark failure'); };
  await runtime.resumePendingParentClosures('s');
  await fire([...timers][0]);
  assert.equal(sent.length, 1, 'an existing durable admission is never replayed after a mark failure');
  assert.equal(timers.size, 1, 'unknown mark result retains a single lease wakeup');
  manager.markParentClosureRecoveryDispatched = mark;
  const lookup = manager.getTurnInputByTurnId;
  manager.getTurnInputByTurnId = (_s, id) => {
    if (id === admitted.recoveryTurnId) throw new Error('controlled late DB read failure');
    return lookup(_s, id);
  };
  await fire([...timers][0]);
  assert.equal(sent.length, 1, 'failed admission lookup never authorizes a send');
  manager.getTurnInputByTurnId = lookup;
  await fire([...timers][0]);
  assert.equal(sent.length, 1);
  assert.equal(store.getParentClosureRecovery('s', 'admission', ownerScope).status, 'dispatched');
  seed('earliest');
  now += 100;
  seed('later');
  await runtime.resumePendingParentClosures('s');
  await runtime.resumePendingParentClosures('s');
  assert.equal(timers.size, 1, 'repeated scans and multiple claims share the earliest timer');
  const early = [...timers][0];
  now = early.at - 1;
  timers.delete(early); await early.fn();
  assert.equal(sent.length, 1, 'an early callback rechecks authoritative expiry');
  await fire([...timers][0]);
  assert.equal(sent.length, 2);
  assert.equal(timers.size, 1, 'next future lease is retained after the earliest completes');
  await fire([...timers][0]);
  assert.equal(sent.length, 3);
  seed('late-send');
  manager.markParentClosureRecoveryDispatched = () => { throw new Error('controlled mark failure after send'); };
  await runtime.resumePendingParentClosures('s');
  await fire([...timers][0]);
  assert.equal(sent.length, 4);
  manager.markParentClosureRecoveryDispatched = mark;
  await fire([...timers][0]);
  assert.equal(sent.length, 4, 'a successful admission followed by a failed mark cannot replay');
  for (const fault of ['scan', 'source']) {
    const row = seed(`transient-${fault}`);
    await runtime.resumePendingParentClosures('s');
    const before = sent.length;
    const scan = manager.listPendingParentClosureRecoveries;
    if (fault === 'scan') manager.listPendingParentClosureRecoveries = () => { throw new Error('transient pending scan'); };
    else manager.getTurnInputByTurnId = (_s, id) => { if (id === row.sourceTurnId) throw new Error('transient source lookup'); return lookup(_s, id); };
    await fire([...timers][0]);
    assert.equal(sent.length, before, 'unknown source/scan cannot authorize send');
    assert.equal(timers.size, 1, `${fault} failure after expiry retains a bounded wakeup`);
    assert.ok([...timers][0].at - now >= 120000, 'failure retry is not a tight poll');
    manager.listPendingParentClosureRecoveries = scan;
    manager.getTurnInputByTurnId = lookup;
    await fire([...timers][0]);
    assert.equal(sent.length, before + 1, `${fault} recovers once after transient read failure`);
  }
  const stableScan = manager.listPendingParentClosureRecoveries;
  seed('future-discovery-failure');
  const futureScan = manager.listFutureParentClosureRecoveries;
  manager.listFutureParentClosureRecoveries = () => { throw new Error('transient future discovery'); };
  const beforeFutureFailure = sent.length;
  await runtime.resumePendingParentClosures('s');
  assert.equal(timers.size, 1, 'startup future discovery failure also retains a bounded wakeup');
  assert.equal(sent.length, beforeFutureFailure);
  manager.listFutureParentClosureRecoveries = futureScan;
  await fire([...timers][0]);
  assert.equal(sent.length, beforeFutureFailure + 1);
  for (const fence of ['cancel', 'owner', 'deleted']) {
    seed(`retry-${fence}`);
    await runtime.resumePendingParentClosures('s');
    const before = sent.length;
    manager.listPendingParentClosureRecoveries = () => { throw new Error('retry fence scan'); };
    await fire([...timers][0]);
    manager.listPendingParentClosureRecoveries = stableScan;
    const pending = [...timers][0];
    if (fence === 'cancel') runtime.cancelPendingParentClosures('s');
    if (fence === 'owner') ownerScope = 'account:other';
    if (fence === 'deleted') session = null;
    await fire(pending);
    assert.equal(sent.length, before, `${fence} fences the delayed error retry`);
    ownerScope = identity.ownerScope; session = { id: 's' };
    manager.cancelPendingParentClosureRecoveries('s');
  }
  seed('bounded-failure');
  await runtime.resumePendingParentClosures('s');
  manager.listPendingParentClosureRecoveries = () => { throw new Error('persistent pending scan'); };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(timers.size, 1);
    await fire([...timers][0]);
  }
  assert.equal(timers.size, 0, 'persistent failure stops after two delayed retries');
  manager.listPendingParentClosureRecoveries = stableScan;
  manager.cancelPendingParentClosureRecoveries('s');
  const countBeforeDispose = sent.length;
  seed('dispose');
  await runtime.resumePendingParentClosures('s');
  const disposedTimer = [...timers][0];
  runtime.dispose();
  assert.equal(timers.size, 0);
  await fire(disposedTimer);
  assert.equal(sent.length, countBeforeDispose, 'disposal fences already queued callbacks');
} finally { Date.now = realNow; runtime.dispose?.(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
console.log('parent closure lease resume: passed');
