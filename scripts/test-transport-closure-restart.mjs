import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MessageStore } = require('../src/main/store/message-store');
const methods = require('../src/main/session-parent-closure-recovery');
const { createTurnRecoveryRuntime } = require('../src/main/turn-recovery-runtime');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-closure-'));
let store = new MessageStore(path.join(root, 'messages.db'), path.join(root, 'blobs'));
const ownerScope = 'account:transport';
const manager = Object.assign({ _find: () => ({ id: 's' }), resolveTurnOwnerScope: () => ({ ok: true, ownerScope }),
  _ensureImported() {}, _store: () => store,
  getTurnInputByTurnId: (_s, id) => store.getTurnInputByTurnId(id, ownerScope),
}, methods);
const sent = [];
const options = { ctx: { sessionManager: manager }, sendUserMessage: async (_s, text, files, opts) => {
  sent.push({ text, files, opts });
  store.admitTurnInput('s', { turnId: opts.turnId, userText: text, files, delivery: 'direct', status: 'admitted', metadata: {}, createdAt: Date.now() }, { ownerScope });
  return { ok: true, turnId: opts.turnId };
} };
let runtime = createTurnRecoveryRuntime(options);
try {
  store.admitTurnInput('s', { turnId: 'source', userText: 'Create report', files: [], delivery: 'direct', status: 'failed', metadata: {}, createdAt: Date.now() }, { ownerScope });
  const source = { objective: 'Create report', taskContract: { active: true, taskType: 'document_work' },
    payload: { failed: true, errorCode: 'MODEL_CONNECTION_FAILED', retryable: true, executionProgressKeys: ['a'.repeat(64)] },
    state: { turnId: 'source', tools: new Map([['write', { id: 'write', name: 'write', status: 'running' }]]) } };
  assert.equal(runtime.prepareParentClosureRecovery('s', source).prepared, true);
  const before = store.getParentClosureRecovery('s', 'source', ownerScope);
  assert.deepEqual(before.source.failure, { failed: true, errorCode: 'MODEL_CONNECTION_FAILED', retryable: true });
  assert.deepEqual(before.source.executionProgressKeys, source.payload.executionProgressKeys);
  runtime.disposeParentClosureRecovery();
  store.close();
  store = new MessageStore(path.join(root, 'messages.db'), path.join(root, 'blobs'));
  runtime = createTurnRecoveryRuntime(options);
  assert.equal(await runtime.resumePendingParentClosures('s'), 1, 'single-tool document recovery survives restart');
  assert.equal(await runtime.resumePendingParentClosures('s'), 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opts.turnId, before.recoveryTurnId, 'durable identity survives restart');
  assert.equal(sent[0].opts.sourceTurnId, 'source');
  assert.equal(sent[0].text, 'Create report');
  assert.equal(sent[0].opts.recovery.kind, 'parent_task_closure');
  assert.match(sent[0].opts.recovery.guidance, /结果未知的写操作先核实/);
  assert.equal(store.getParentClosureRecovery('s', 'source', ownerScope).status, 'dispatched');
} finally { runtime.disposeParentClosureRecovery(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
console.log('transport closure restart passed');
