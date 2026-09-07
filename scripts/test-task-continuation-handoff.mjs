import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shouldRecoverParentClosure } = require('../src/main/parent-task-closure');
const input = { sessionId: 's', taskContract: { active: true, taskType: 'code_change' }, state: { turnId: 't', tools: new Map([['edit', { name: 'edit', status: 'done' }]]) }, payload: { code: 0, continuationHandoff: { schemaVersion: 1, reason: 'budget_exhausted', progress: 2, unfinished: [{ title: 'run remaining acceptance', status: 'pending' }] } } };
assert.equal(shouldRecoverParentClosure(input).ok, true, 'clean partial progress can hand off after shared budget exhaustion');
for (const patch of [{ progress: 0 }, { unfinished: [] }, { reason: 'no_progress' }, { schemaVersion: 0 }]) {
  assert.equal(shouldRecoverParentClosure({ ...input, payload: { ...input.payload, continuationHandoff: { ...input.payload.continuationHandoff, ...patch } } }).ok, false);
}
assert.equal(shouldRecoverParentClosure({ ...input, state: { ...input.state, pendingQuestions: new Map([['q', {}]]) } }).ok, false, 'never bypass user input');
for (const field of ['pendingPermissions', 'pendingHooks']) {
  assert.equal(shouldRecoverParentClosure({ ...input, state: { ...input.state, [field]: new Map([['pending', {}]]) } }).ok, false, `${field} prevents continuation`);
}
assert.equal(shouldRecoverParentClosure({ ...input, recoveryLedger: { has: () => true } }).ok, false, 'a duplicate terminal cannot claim another continuation');
assert.equal(shouldRecoverParentClosure({ ...input, state: { ...input.state, currentPayload: { parentClosureRecovery: true } } }).ok, false, 'recovery cannot recursively spawn another recovery');
assert.equal(shouldRecoverParentClosure({ ...input, payload: { ...input.payload, interruptedByUser: true } }).ok, false);
console.log('task continuation handoff passed');
