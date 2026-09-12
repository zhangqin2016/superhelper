import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { openDatabase } = require('../src/main/store/sqlite-db');
const { createQueueRecoveryEnvelope } = require('../src/main/turn-queue-recovery-envelope');
const { queueRecoveryEnvelope } = require('../src/main/turn-admission-runtime');
const modulePath = '../src/main/store/task-continuation-budget';
assert.ok(fs.existsSync(new URL('../src/main/store/task-continuation-budget.js', import.meta.url)),
  'durable continuation budget module must exist');
const { reserveTaskContinuation, cancelTaskContinuations, validateTaskContinuation } = require(modulePath);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-budget-'));
const file = path.join(scratch, 'budget.db');
let db = openDatabase(file);
const key = (text) => createHash('sha256').update(String(text)).digest('hex');
const base = { sessionId: 'session', ownerScope: 'owner', now: 1000 };
const seed = (id, status = 'completed', session = 'session', owner = 'owner') =>
  db.run('INSERT INTO turn_inputs (turn_id, session_id, owner_scope, status) VALUES (?, ?, ?, ?)',
    id, session, owner, status);
const reserve = (source, target, keys = [], extra = {}) => reserveTaskContinuation(db,
  { ...base, sourceTurnId: source, continuationTurnId: target, progressKeys: keys, ...extra });
const denied = (result, reason) => {
  assert.equal(result.ok, false);
  if (reason) assert.equal(result.reason, reason);
};
const recovery = (id, parent) => {
  seed(id);
  db.run('UPDATE turn_inputs SET metadata_json = ? WHERE turn_id = ?', JSON.stringify({
    queueRecovery: createQueueRecoveryEnvelope({ item: { id: `queue-${id}` },
      options: { sourceTurnId: parent, recordUser: false, recovery: { kind: 'connection_repair' } } }),
  }), id);
};
try {
  db.exec(`CREATE TABLE turn_inputs (
    turn_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner_scope TEXT NOT NULL,
    status TEXT NOT NULL, terminal_type TEXT, migration_status TEXT DEFAULT 'owned',
    metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 1
  )`);
  seed('root');
  assert.deepEqual(reserve('root', 'c1'), { ok: true, rootTurnId: 'root', rounds: 1 });
  assert.deepEqual(reserve('root', 'c1'), { ok: true, rootTurnId: 'root', rounds: 1, duplicate: true });
  seed('c1');
  denied(reserve('c1', 'bad-empty'), 'TASK_CONTINUATION_NO_PROGRESS');
  for (const keys of [['not-a-hash'], ['a'.repeat(63)], [42], null, Array(129).fill(key('a'))]) {
    denied(reserve('c1', 'bad-key', keys), 'TASK_CONTINUATION_INVALID_PROGRESS');
  }
  assert.equal(reserve('c1', 'c2', [key('one')]).ok, true);
  seed('c2');
  denied(reserve('c2', 'repeat', [key('one')]), 'TASK_CONTINUATION_NO_PROGRESS');
  db.close();
  db = openDatabase(file);
  denied(reserve('c2', 'repeat-after-reopen', [key('one')]), 'TASK_CONTINUATION_NO_PROGRESS');
  for (let i = 3; i <= 8; i++) {
    assert.deepEqual(reserve(`c${i - 1}`, `c${i}`, [key(i)]),
      { ok: true, rootTurnId: 'root', rounds: i });
    seed(`c${i}`);
  }
  for (let i = 9; i <= 12; i++) {
    denied(reserve('c8', `c${i}`, [key(i)], { rootTurnId: 'invented', maxRounds: 999 }),
      'TASK_CONTINUATION_BUDGET_EXHAUSTED');
  }
  denied(reserve('root', 'branch-cap', [key('branch')]), 'TASK_CONTINUATION_BUDGET_EXHAUSTED');
  db.close();
  db = openDatabase(file);
  denied(reserve('c8', 'restart-cap', [key('restart')]), 'TASK_CONTINUATION_BUDGET_EXHAUSTED');
  assert.equal(reserve('c7', 'c8').duplicate, true, 'same admission survives exhausted budget');
  denied(reserve('c6', 'c8'), 'TASK_CONTINUATION_IDENTITY_CONFLICT');
  denied(reserve('absent', 'new'), 'TASK_CONTINUATION_SOURCE_UNAVAILABLE');
  denied(reserve('root', 'c1', [], { ownerScope: 'foreign' }));
  denied(reserve('root', 'c1', [], { sessionId: 'foreign' }));
  seed('foreign-source', 'completed', 'other', 'other-owner');
  denied(reserve('foreign-source', 'c1', [], { ownerScope: 'other-owner', sessionId: 'other' }),
    'TASK_CONTINUATION_IDENTITY_CONFLICT');
  denied(reserve('root', 'foreign-source'), 'TASK_CONTINUATION_IDENTITY_CONFLICT');
  seed('existing-target');
  denied(reserve('root', 'existing-target'), 'TASK_CONTINUATION_IDENTITY_CONFLICT');
  denied(reserve('root', 'root'), 'TASK_CONTINUATION_IDENTITY_CONFLICT');
  seed('clock-root');
  assert.equal(reserve('clock-root', 'clock1').ok, true);
  seed('clock1');
  denied(reserve('clock1', 'clock2', [key('clock')], { now: 1000 + 24 * 60 * 60 * 1000 }),
    'TASK_CONTINUATION_DEADLINE');
  assert.equal(reserve('clock1', 'clock2', [key('clock')], { now: 1000 + 24 * 60 * 60 * 1000 - 1 }).ok, true);
  for (const status of ['interrupted', 'cancelled']) {
    seed(status, status);
    denied(reserve(status, `${status}-next`), 'TASK_CONTINUATION_CANCELLED');
  }
  seed('cancel-root');
  assert.equal(reserve('cancel-root', 'cancel1', [key('initial')]).ok, true);
  seed('cancel1');
  db.run("UPDATE turn_inputs SET status = 'cancelled' WHERE turn_id = 'cancel-root'");
  denied(reserve('cancel1', 'cancel2', [key('fresh')]), 'TASK_CONTINUATION_CANCELLED');
  denied(reserve('cancel-root', 'cancel1'), 'TASK_CONTINUATION_CANCELLED');
  denied(reserve('cancel-root', 'cancel-sibling', [key('sibling')]), 'TASK_CONTINUATION_CANCELLED');
  db.run("UPDATE turn_inputs SET status = 'completed' WHERE turn_id = 'cancel-root'");
  db.run("UPDATE turn_inputs SET status = 'interrupted' WHERE turn_id = 'cancel1'");
  denied(reserve('cancel-root', 'cancel1'), 'TASK_CONTINUATION_CANCELLED');
  denied(reserve('cancel-root', 'cancelled-chain-sibling', [key('sibling')]), 'TASK_CONTINUATION_CANCELLED');
  seed('missing-root');
  assert.equal(reserve('missing-root', 'orphan').ok, true);
  seed('orphan');
  db.run("DELETE FROM turn_inputs WHERE turn_id = 'missing-root'");
  denied(reserve('orphan', 'orphan2', [key('orphan')]), 'TASK_CONTINUATION_SOURCE_UNAVAILABLE');
  seed('unowned');
  db.run("UPDATE turn_inputs SET migration_status = 'legacy_ambiguous' WHERE turn_id = 'unowned'");
  denied(reserve('unowned', 'unowned2'), 'TASK_CONTINUATION_SOURCE_UNAVAILABLE');
  seed('hash-root');
  const initialKeys = Array.from({ length: 128 }, (_, i) => key(`initial-${i}`));
  assert.equal(reserve('hash-root', 'hash1', initialKeys).ok, true);
  seed('hash1');
  denied(reserve('hash1', 'hash2', [initialKeys[0].toUpperCase()]), 'TASK_CONTINUATION_NO_PROGRESS');
  assert.equal(reserve('hash1', 'hash2', [initialKeys[0], key('new-hash')]).ok, true);
  seed('terminal-cancel');
  db.run("UPDATE turn_inputs SET terminal_type = 'turn.interrupted' WHERE turn_id = 'terminal-cancel'");
  denied(reserve('terminal-cancel', 'terminal-next'), 'TASK_CONTINUATION_CANCELLED');
  seed('branch-root');
  assert.equal(reserve('branch-root', 'branch1', [key('branch-1')]).rounds, 1);
  assert.equal(reserve('branch-root', 'branch2', [key('branch-2')]).rounds, 2,
    'two source branches consume one root budget even before dispatch');
  denied(reserve('branch1', 'unadmitted', [key('unadmitted')]), 'TASK_CONTINUATION_SOURCE_UNAVAILABLE');
  recovery('rescue-of-c8', 'c8');
  const rescueCap = reserve('rescue-of-c8', 'bypass-cap', [key('rescue-progress')]);
  denied(rescueCap, 'TASK_CONTINUATION_BUDGET_EXHAUSTED');
  assert.equal(rescueCap.rootTurnId, 'root');
  recovery('rescue-of-rescue', 'rescue-of-c8');
  denied(reserve('rescue-of-rescue', 'bypass-chain', [key('another')]), 'TASK_CONTINUATION_BUDGET_EXHAUSTED');
  seed('rescue-root');
  recovery('rescue-before-first-claim', 'rescue-root');
  assert.deepEqual(reserve('rescue-before-first-claim', 'rescue-claim'),
    { ok: true, rootTurnId: 'rescue-root', rounds: 1 });
  assert.equal(reserve('rescue-root', 'rescue-branch', [key('fresh-rescue')]).rounds, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM task_continuation_claims WHERE root_turn_id = 'rescue-root'").n, 2,
    'specialized recovery ancestry itself does not consume general continuation claims');
  recovery('rescue-no-progress', 'hash1');
  denied(reserve('rescue-no-progress', 'rescue-repeated', [initialKeys[0]]), 'TASK_CONTINUATION_NO_PROGRESS');
  recovery('rescue-clock', 'clock1');
  denied(reserve('rescue-clock', 'rescue-expired', [key('rescue-clock')], { now: 1000 + 24 * 60 * 60 * 1000 }),
    'TASK_CONTINUATION_DEADLINE');
  for (const [id, parent] of [['missing-rescue', 'missing-ancestor'], ['foreign-rescue', 'foreign-source'],
    ['cancelled-rescue', 'cancel-root'], ['unowned-rescue', 'unowned']]) {
    recovery(id, parent);
    denied(reserve(id, `${id}-next`, [key(id)]));
  }
  recovery('cancelled-mid', 'rescue-root');
  recovery('cancelled-descendant', 'cancelled-mid');
  db.run("UPDATE turn_inputs SET status = 'interrupted' WHERE turn_id = 'cancelled-mid'");
  denied(reserve('cancelled-descendant', 'cancelled-next', [key('stopped')]), 'TASK_CONTINUATION_CANCELLED');
  seed('claimed-after-rescue-root');
  recovery('claimed-after-rescue-mid', 'claimed-after-rescue-root');
  assert.equal(reserve('claimed-after-rescue-mid', 'claimed-after-rescue-child').ok, true);
  seed('claimed-after-rescue-child');
  db.run("UPDATE turn_inputs SET status = 'cancelled' WHERE turn_id = 'claimed-after-rescue-mid'");
  denied(reserve('claimed-after-rescue-child', 'claimed-cancelled-ancestor', [key('cancelled ancestor')]),
    'TASK_CONTINUATION_CANCELLED');
  recovery('cycle-a', 'cycle-b');
  recovery('cycle-b', 'cycle-a');
  denied(reserve('cycle-a', 'cycle-next', [key('cycle')]));
  for (const [id, metadata] of [['malformed-rescue', { queueRecovery: { options: { sourceTurnId: 'root' } } }],
    ['invalid-source-rescue', { queueRecovery: createQueueRecoveryEnvelope({ item: { id: 'invalid' }, options: { sourceTurnId: 42 } }) }]]) {
    seed(id);
    db.run('UPDATE turn_inputs SET metadata_json = ? WHERE turn_id = ?', JSON.stringify(metadata), id);
    denied(reserve(id, `${id}-next`, [key(id)]));
  }
  seed('ordinary-user');
  db.run('UPDATE turn_inputs SET metadata_json = ? WHERE turn_id = ?',
    JSON.stringify({ sourceTurnId: 'root', recovery: { sourceTurnId: 'root' } }), 'ordinary-user');
  assert.deepEqual(reserve('ordinary-user', 'ordinary-next'), { ok: true, rootTurnId: 'ordinary-user', rounds: 1 },
    'caller-like metadata outside the protected recovery envelope cannot rewrite ancestry');
  seed('queued-user');
  db.run('UPDATE turn_inputs SET metadata_json = ? WHERE turn_id = ?', JSON.stringify({
    queueRecovery: queueRecoveryEnvelope({ id: 'ordinary-queue', options: { recordUser: true } }),
  }), 'queued-user');
  assert.deepEqual(reserve('queued-user', 'queued-user-next'), { ok: true, rootTurnId: 'queued-user', rounds: 1 },
    'real user admission emits sourceTurnId:null and must retain ordinary continuation');
  for (const sourceTurnId of [null, '', undefined]) {
    const id = `missing-recovery-source-${String(sourceTurnId)}`;
    seed(id);
    db.run('UPDATE turn_inputs SET metadata_json = ? WHERE turn_id = ?', JSON.stringify({
      queueRecovery: queueRecoveryEnvelope({ id: `queue-${id}`, options: { recordUser: false, sourceTurnId } }),
    }), id);
    denied(reserve(id, `${id}-next`), 'TASK_CONTINUATION_SOURCE_UNAVAILABLE');
  }
  seed('deep-root');
  for (let index = 1; index <= 129; index++) recovery(`deep-${index}`, index === 1 ? 'deep-root' : `deep-${index - 1}`);
  denied(reserve('deep-129', 'too-deep', [key('depth')]), 'TASK_CONTINUATION_SOURCE_UNAVAILABLE');
  db.close();
  db = openDatabase(file);
  denied(reserve('rescue-of-rescue', 'restart-rescue-bypass', [key('after-reopen')]), 'TASK_CONTINUATION_BUDGET_EXHAUSTED');
  assert.equal(typeof cancelTaskContinuations, 'function', 'idle stop requires a durable continuation cancellation fence');
  seed('idle-background-source');
  assert.deepEqual(cancelTaskContinuations(db, { ...base, now: 2000 }), { ok: true, cancelledAt: 2000 });
  denied(reserve('idle-background-source', 'idle-background-wake', [], { now: 2100 }), 'TASK_CONTINUATION_CANCELLED');
  db.close();
  db = openDatabase(file);
  denied(reserve('idle-background-source', 'restart-idle-wake', [], { now: 2200 }), 'TASK_CONTINUATION_CANCELLED');
  recovery('late-rescue-old-root', 'idle-background-source');
  db.run("UPDATE turn_inputs SET created_at = 2200 WHERE turn_id = 'late-rescue-old-root'");
  denied(reserve('late-rescue-old-root', 'late-rescue-wake', [], { now: 2300 }), 'TASK_CONTINUATION_CANCELLED');
  seed('new-manual-request');
  db.run("UPDATE turn_inputs SET created_at = 2001 WHERE turn_id = 'new-manual-request'");
  assert.equal(reserve('new-manual-request', 'new-manual-wake', [], { now: 2100 }).ok, true);
  seed('exact-cancel-time');
  db.run("UPDATE turn_inputs SET created_at = 2000 WHERE turn_id = 'exact-cancel-time'");
  assert.deepEqual(cancelTaskContinuations(db, { ...base, now: 1000 }), { ok: true, cancelledAt: 2000 },
    'an older delayed cancellation cannot rewind the durable fence');
  denied(reserve('exact-cancel-time', 'exact-cancel-wake', [], { now: 2100 }), 'TASK_CONTINUATION_CANCELLED');
  seed('other-owner-root', 'completed', 'session', 'other-owner');
  assert.equal(reserve('other-owner-root', 'other-owner-wake', [], { ownerScope: 'other-owner', now: 2100 }).ok, true);
  seed('other-session-root', 'completed', 'other-session', 'owner');
  assert.equal(reserve('other-session-root', 'other-session-wake', [], { sessionId: 'other-session', now: 2100 }).ok, true);
  assert.equal(typeof validateTaskContinuation, 'function', 'dispatch must recheck reserved continuation cancellation');
  assert.deepEqual(validateTaskContinuation(db, { ...base, continuationTurnId: 'ordinary-not-reserved' }), { ok: true });
  denied(validateTaskContinuation(db, { ...base, continuationTurnId: 'c1', now: 2100 }), 'TASK_CONTINUATION_CANCELLED');
  const claimsBeforeValidation = db.get('SELECT COUNT(*) AS n FROM task_continuation_claims').n;
  assert.equal(validateTaskContinuation(db, { ...base, continuationTurnId: 'new-manual-wake', now: 2100 }).ok, true);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM task_continuation_claims').n, claimsBeforeValidation,
    'dispatch validation never spends an additional claim');
  denied(validateTaskContinuation(db, { ...base, continuationTurnId: 'other-owner-wake', now: 2100 }),
    'TASK_CONTINUATION_IDENTITY_CONFLICT');
  const { MessageStore } = require('../src/main/store/message-store');
  let realStore = new MessageStore(path.join(scratch, 'real-messages.db'), path.join(scratch, 'blobs'));
  try {
    const realSource = realStore.admitTurnInput('real-session', {
      turnId: 'real-user', delivery: 'direct', status: 'completed', userText: 'Finish the complete report', createdAt: 10,
    }, { ownerScope: 'real-owner', queueRecoveryEnvelope: queueRecoveryEnvelope({ id: 'real-queue', options: {} }) });
    assert.equal(realSource.metadata.queueRecovery.options.sourceTurnId, null);
    realStore.close();
    realStore = new MessageStore(path.join(scratch, 'real-messages.db'), path.join(scratch, 'blobs'));
    assert.deepEqual(reserveTaskContinuation(realStore.db, { sessionId: 'real-session', ownerScope: 'real-owner',
      sourceTurnId: 'real-user', continuationTurnId: 'real-next', progressKeys: [], now: 20 }),
    { ok: true, rootTurnId: 'real-user', rounds: 1 }, 'actual persisted user admission survives restart and allows continuation');
    const admitDirect = (turnId, sourceTurnId, ownerScope = 'real-owner') => realStore.admitTurnInput('real-session', {
      turnId, delivery: 'direct', status: 'completed', userText: 'Continue original task', createdAt: 21,
    }, { ownerScope, sourceTurnId });
    admitDirect('real-next', 'real-user');
    let previous = 'real-next';
    for (let round = 2; round <= 8; round++) {
      const next = `real-next-${round}`;
      assert.equal(reserveTaskContinuation(realStore.db, { sessionId: 'real-session', ownerScope: 'real-owner',
        sourceTurnId: previous, continuationTurnId: next, progressKeys: [key(round)], now: 22 }).rounds, round);
      admitDirect(next, previous);
      previous = next;
    }
    const directRescue = admitDirect('real-direct-rescue', previous);
    assert.equal(directRescue.metadata.queueRecovery, undefined, 'direct source inheritance does not carry a queue envelope');
    admitDirect('real-direct-rescue-child', 'real-direct-rescue');
    const realReserve = (sourceTurnId, continuationTurnId, ownerScope = 'real-owner') =>
      reserveTaskContinuation(realStore.db, { sessionId: 'real-session', ownerScope,
        sourceTurnId, continuationTurnId, progressKeys: [key('direct')], now: 23 });
    denied(realReserve('real-direct-rescue-child', 'real-direct-bypass'), 'TASK_CONTINUATION_BUDGET_EXHAUSTED');
    admitDirect('real-direct-rescue', 'nonexistent-replacement');
    denied(realReserve('real-direct-rescue', 'real-direct-duplicate-bypass'), 'TASK_CONTINUATION_BUDGET_EXHAUSTED');
    admitDirect('real-foreign-source-child', 'real-user', 'foreign-owner');
    denied(realReserve('real-foreign-source-child', 'real-foreign-wake', 'foreign-owner'), 'TASK_CONTINUATION_SOURCE_UNAVAILABLE');
    realStore.close();
    realStore = new MessageStore(path.join(scratch, 'real-messages.db'), path.join(scratch, 'blobs'));
    denied(realReserve('real-direct-rescue-child', 'real-direct-restart-bypass'), 'TASK_CONTINUATION_BUDGET_EXHAUSTED');
    realStore.admitTurnInput('real-session', { turnId: 'real-replacement', delivery: 'direct',
      status: 'completed', userText: 'Do the replacement user task', createdAt: 100 }, {
      ownerScope: 'real-owner', queueRecoveryEnvelope: queueRecoveryEnvelope({ id: 'replacement-queue', options: {} }),
    });
    const realCancel = (now, preservedTurnId) => cancelTaskContinuations(realStore.db,
      { sessionId: 'real-session', ownerScope: 'real-owner', now, preservedTurnId });
    assert.equal(realCancel(101, 'real-replacement').ok, true);
    assert.equal(realReserve('real-replacement', 'replacement-next').ok, true,
      'a replacement user turn admitted before interrupt epoch remains eligible');
    denied(realReserve('real-user', 'old-after-replacement'), 'TASK_CONTINUATION_CANCELLED');
    realStore.close();
    realStore = new MessageStore(path.join(scratch, 'real-messages.db'), path.join(scratch, 'blobs'));
    assert.equal(realReserve('real-replacement', 'replacement-next').ok, true, 'exact replacement exemption survives restart');
    realCancel(99, 'real-user');
    denied(realReserve('real-user', 'older-cancel-must-not-preserve'), 'TASK_CONTINUATION_CANCELLED');
    assert.equal(realReserve('real-replacement', 'replacement-next').ok, true);
    realCancel(102);
    denied(realReserve('real-replacement', 'replacement-next'), 'TASK_CONTINUATION_CANCELLED');
    realCancel(103, 'real-direct-rescue-child');
    denied(realReserve('real-direct-rescue-child', 'invalid-rescue-exemption'), 'TASK_CONTINUATION_CANCELLED');
    realCancel(104, 'real-foreign-source-child');
    denied(realReserve('real-replacement', 'foreign-preservation-cannot-open'), 'TASK_CONTINUATION_CANCELLED');
  } finally { realStore.close(); }
  console.log('task continuation durable budget: cap, progress, identity, cancellation and restart passed');
} finally {
  db.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
