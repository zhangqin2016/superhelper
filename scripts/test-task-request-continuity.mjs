import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveTurnIntelligence } = require('../src/main/turn-intelligence');
const { createTaskCoreEnvelope } = require('../src/main/task-core-contracts');
const { originalAcceptance, assessObjectiveCoverage } = require('../src/main/task-original-acceptance');
const { applyModelIntentCandidate, relationForText } = require('../src/main/intent-contract');

const session = { id: 'continuity-fixture', projectId: 'p', messages: [] };
const inputs = new Map();
const manager = {
  getConversation: () => session.messages,
  resolveTurnOwnerScope: () => ({ ok: true, ownerScope: 'owner' }),
  getTurnInputByTurnId: (id, turnId) => id === session.id ? inputs.get(turnId) : null,
};
function turn(id, text) {
  inputs.set(id, { sessionId: session.id, turnId: id, ownerScope: 'owner', userText: text });
  const result = resolveTurnIntelligence({ ctx: { sessionManager: manager }, session, text, turnId: id });
  const core = createTaskCoreEnvelope({ sessionId: session.id, projectId: 'p',
    admission: { sessionId: session.id, turnId: id, ownerScope: 'owner' },
    contextSnapshot: { sessionId: session.id }, taskContract: result.taskContract });
  inputs.get(id).taskCore = core;
  const state = { taskContract: result.taskContract, taskCore: core,
    taskRequest: result.taskRequest, enginePayload: { rawText: text } };
  session.messages.push({ role: 'assistant', turnId: id, record: {
    user: { text }, meta: { taskContract: result.taskContract },
  } });
  return state;
}
const full = '修复现有代码并运行测试。' + '保留现有行为和兼容性。'.repeat(160) + '\n另外必须交付 SECURITY.md。';
const first = turn('first', full);
const second = turn('second', '继续');
assert.ok(originalAcceptance(second).objective.includes('必须交付 SECURITY.md'), 'continued acceptance must read full original input, not the 1000-character summary');
assert.ok(second.taskCore.contract.intentContract.requestSource, 'source reference survives immutable TaskCore');
assert.ok(JSON.stringify(second.taskCore).length < full.length + JSON.stringify(first.taskCore).length, 'do not embed full history in TaskCore');
for (const text of ['好的，继续', '可以，继续', 'Please continue', 'OK, continue']) {
  assert.equal(relationForText(text, true), 'continue', text);
}
assert.equal(relationForText('好的，新任务：写报告', true), 'new');
assert.equal(relationForText('可以介绍下天气吗', true), 'new');
assert.equal(relationForText('Please continue', false), 'new');
const refined = applyModelIntentCandidate(second.taskContract.intentContract, {
  objective: 'Model summary', requestSource: { turnIds: ['foreign'] },
});
assert.deepEqual(refined.requestSource, second.taskContract.intentContract.requestSource, 'model cannot rewrite host input lineage');
const otherTask = turn('other-task', '新任务：修改另一个代码文件');
const background = resolveTurnIntelligence({ ctx: { sessionManager: manager }, session,
  text: 'Continue completed background job abc', turnId: 'background',
  previousIntentContract: second.taskCore.contract.intentContract });
assert.equal(background.taskContract.intentContract.contractId, second.taskContract.intentContract.contractId,
  'an explicit trusted background source cannot inherit whichever unrelated conversation task is newest');
assert.notEqual(background.taskContract.intentContract.contractId, otherTask.taskContract.intentContract.contractId);
const unresolvedBackground = resolveTurnIntelligence({ ctx: { sessionManager: manager }, session,
  text: '继续修改代码', turnId: 'missing-background', missingRecoverySource: true });
assert.notEqual(unresolvedBackground.taskContract.intentContract.contractId, otherTask.taskContract.intentContract.contractId,
  'missing background source must not silently inherit the newest unrelated task');
assert.equal(unresolvedBackground.taskRequest.complete, false);
session.messages.pop();
inputs.delete('first');
const missing = turn('third', '继续');
assert.equal(missing.taskRequest.complete, false, 'missing durable source is explicit');
assert.equal((await assessObjectiveCoverage({ state: missing })).status, 'unknown');
inputs.set('first', { sessionId: 'foreign', ownerScope: 'owner', turnId: 'first', userText: 'PRIVATE_FOREIGN_TEXT' });
const foreign = turn('fourth', '继续');
assert.equal(foreign.taskRequest.complete, false);
assert.ok(!originalAcceptance(foreign).objective.includes('PRIVATE_FOREIGN_TEXT'));
const fresh = turn('new', '新任务：修改另一个代码文件');
assert.ok(!originalAcceptance(fresh).objective.includes('SECURITY.md'));
session.messages.push({ role: 'assistant', content: '你好', record: { meta: {} } });
assert.equal(turn('casual', '继续').taskContract.active, false);
const sourceModule = require('../src/main/task-request-source');
const originalBind = sourceModule.bindTaskRequest;
try {
  sourceModule.bindTaskRequest = () => { throw new Error('optional lineage helper unavailable'); };
  const baseline = resolveTurnIntelligence({ ctx: { sessionManager: manager }, session,
    text: '新任务：修改代码并运行测试', turnId: 'helper-failure' });
  assert.equal(baseline.taskContract.active, true, 'optional lineage failure cannot demote the native task contract');
  assert.equal(baseline.taskRequest.complete, false);
} finally { sourceModule.bindTaskRequest = originalBind; }
console.log('task request continuity passed');

// Exercise the actual durable input + immutable TaskCore path, not just the
// in-memory admission fixture above. Restart before binding the continuation.
const { MessageStore } = require('../src/main/store/message-store');
const { TURN_INPUT_MIGRATION_OWNED } = require('../src/main/store/turn-admission-migration');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'request-lineage-'));
let store = new MessageStore(path.join(scratch, 'messages.db'), path.join(scratch, 'blobs'));
try {
  store.db.run(`INSERT INTO turn_inputs
    (session_id, admitted_seq, turn_id, delivery, status, user_text,
     files_json, metadata_json, created_at, owner_scope, migration_status)
    VALUES (?, 1, ?, 'direct', 'admitted', ?, '[]', '{}', ?, ?, ?)`,
    session.id, 'first', full, Date.now(), 'owner', TURN_INPUT_MIGRATION_OWNED);
  assert.equal(store.persistTurnTaskCore({ sessionId: session.id, turnId: 'first', ownerScope: 'owner', taskCore: first.taskCore }).ok, true);
  store.close();
  store = new MessageStore(path.join(scratch, 'messages.db'), path.join(scratch, 'blobs'));
  const restored = store.getTurnInputByTurnId('first', 'owner');
  const result = resolveTurnIntelligence({ session, text: '继续', turnId: 'restored-continuation',
    previousIntentContract: restored.taskCore.contract.intentContract,
    ctx: { sessionManager: { ...manager, getTurnInputByTurnId: (_session, id) => store.getTurnInputByTurnId(id, 'owner') } } });
  assert.equal(result.taskRequest.complete, true);
  assert.ok(originalAcceptance({ taskContract: result.taskContract, taskRequest: result.taskRequest }).objective.includes('必须交付 SECURITY.md'));
  assert.equal(store.getTurnInputByTurnId('first', 'another-owner'), null);
  console.log('task request SQLite restart continuity passed');
} finally { store.close(); fs.rmSync(scratch, { recursive: true, force: true }); }
