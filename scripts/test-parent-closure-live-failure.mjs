import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { MessageStore } = require('../src/main/store/message-store');
const methods = require('../src/main/session-parent-closure-recovery');
const { createTurnRecoveryRuntime } = require('../src/main/turn-recovery-runtime');

for (const fault of ['lookup', 'mark-throws', 'mark-rejects', 'send-unknown', 'late-send-unknown', 'scan-late-send-unknown', 'cancel-during-send', 'dispose-during-send']) test(`live recovery: ${fault}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-live-'));
  const store = new MessageStore(path.join(root, 'messages.db'), path.join(root, 'blobs'));
  const ownerScope = 'account:live';
  const timers = new Set();
  let now = Date.now(), sends = 0, fallback = 0, failing = true;
  store.admitTurnInput('s', { turnId: 'source', delivery: 'direct', status: 'completed', userText: 'Finish and test', files: [], metadata: {}, createdAt: now }, { ownerScope });
  const source = { objective: 'Finish and test', taskContract: { active: true, taskType: 'code_change' },
    state: { turnId: 'source', tools: new Map([['read', { id: 'read', name: 'read', status: 'done' }]]),
      pendingPermissions: new Map(), pendingQuestions: new Map(), pendingHooks: new Map() }, payload: { stalled: true } };
  const manager = Object.assign({ _find: () => ({ id: 's' }), resolveTurnOwnerScope: () => ({ ok: true, ownerScope }),
    _ensureImported() {}, _store: () => store,
    getTurnInputByTurnId: (_s, id) => {
      if (failing && fault === 'lookup' && id !== 'source') throw Error('injected live lookup failure');
      return store.getTurnInputByTurnId(id, ownerScope);
    } }, methods);
  const mark = manager.markParentClosureRecoveryDispatched.bind(manager);
  manager.markParentClosureRecoveryDispatched = (...args) => {
    if (failing && fault === 'mark-throws') throw Error('injected mark failure after admission');
    if (failing && fault === 'mark-rejects') return { ok: false, reason: 'INJECTED_MARK_FAILURE' };
    return mark(...args);
  };
  const runtime = createTurnRecoveryRuntime({ ctx: { sessionManager: manager }, now: () => now,
    setTimeout: (fn, ms) => { const timer = { fn, at: now + ms, unref() {} }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer), sendUserMessage: async (_s, text, files, opts) => {
      sends++;
      store.admitTurnInput('s', { turnId: opts.turnId, delivery: 'direct', status: 'admitted', userText: text, files, metadata: {}, createdAt: now }, { ownerScope });
      if (fault === 'cancel-during-send') { runtime.cancelPendingParentClosures('s'); throw Error('injected late response after cancel'); }
      if (fault === 'dispose-during-send') { runtime.disposeParentClosureRecovery(); throw Error('injected late response after dispose'); }
      if (failing && fault === 'send-unknown') throw Error('injected lost send response');
      if (failing && fault.includes('late-send-unknown')) { now += 120001; throw Error('injected lost response after lease expiry'); }
      return { ok: true, turnId: opts.turnId };
    } });
  try {
    if (fault.startsWith('scan-')) {
      assert.equal(runtime.prepareParentClosureRecovery('s', source).prepared, true);
      assert.equal(await runtime.resumePendingParentClosures('s'), 0, 'scan cannot count the unknown send as dispatched');
    } else {
      const result = await runtime.afterParentClosureTerminal('s', source, { failed: true, selfHeal: async () => { fallback++; } });
      assert.equal(fallback, 0, 'owned/unknown recovery cannot start a competing self-heal');
      assert.equal(result.attempted, true);
      assert.equal(result.ok, false, 'unconfirmed durable receipt cannot report successful dispatch');
      if (fault.endsWith('during-send')) {
        assert.equal(timers.size, 0, 'late failure must not rearm canceled/disposed recovery');
        if (fault.startsWith('cancel')) assert.equal(store.getParentClosureRecovery('s', 'source', ownerScope).status, 'unavailable');
        return;
      }
    }
    assert.equal(timers.size, 1, 'live claimed failure must retain an expiry wakeup without restarting the app');
    const row = store.getParentClosureRecovery('s', 'source', ownerScope);
    assert.equal(row.status, 'claimed');
    if (!fault.includes('late-send-unknown')) await runtime.afterParentClosureTerminal('s', source, { failed: true, selfHeal: async () => { fallback++; } });
    assert.equal(fallback, 0, 'duplicate live terminal cannot launch a competing recovery while lease is held');
    const reconciled = store.getParentClosureRecovery('s', 'source', ownerScope).status === 'dispatched';
    assert.equal(timers.size, reconciled ? 0 : 1, 'duplicate terminal either reconciles an expired admission or preserves its wakeup');
    failing = false;
    if (!reconciled) { const timer = [...timers][0]; timers.delete(timer); now = timer.at; await timer.fn(); }
    assert.equal(sends, 1, 'lookup retries send once; already-admitted and unknown sends only reconcile');
    assert.equal(store.getParentClosureRecovery('s', 'source', ownerScope).recoveryTurnId, row.recoveryTurnId);
    assert.equal(store.getParentClosureRecovery('s', 'source', ownerScope).status, 'dispatched');
    assert.equal(timers.size, 0);
  } finally { runtime.disposeParentClosureRecovery(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
