import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sourceTaskCoreForTurn, sourceTurnIdForTurn } = require('../src/main/task-core-runtime');
for (const [state, opts] of [[{}, { sourceTurnId: 'source' }], [{ admittedTurnInput: { sourceTurnId: 'source' } }, {}],
  [{ admittedTurnInput: { metadata: { queueRecovery: { options: { sourceTurnId: 'source' } } } } }, {}]]) {
  assert.equal(sourceTurnIdForTurn(state, opts), 'source', 'missing-source guard and resolver share all source identity paths');
}
assert.equal(typeof sourceTaskCoreForTurn, 'function', 'live and restored source turns need the same host resolver');
const core = { sessionId: 's', turnId: 'source', ownerScope: 'owner', projectId: 'p', contract: { objective: 'original' } };
const session = { id: 's', projectId: 'p' };
const state = { admittedTurnInput: { ownerScope: 'owner', sourceTurnId: 'source' } };
const manager = { getTurnInputByTurnId: (sessionId, turnId) => {
  assert.equal(sessionId, 's'); assert.equal(turnId, 'source');
  return { sessionId: 's', turnId: 'source', ownerScope: 'owner', taskCore: core };
} };
assert.equal(sourceTaskCoreForTurn({ sessionManager: manager }, session, state, {}), core);
assert.equal(sourceTaskCoreForTurn({ sessionManager: manager }, session, state, { sourceTaskCore: { ...core, contract: {} } }), core, 'durable source outranks passed snapshot');
for (const bad of [{ sessionId: 'foreign' }, { ownerScope: 'foreign' }, { turnId: 'other' }, { projectId: 'other' }]) {
  const ctx = { sessionManager: { getTurnInputByTurnId: () => ({ sessionId: 's', turnId: 'source', ownerScope: 'owner', taskCore: { ...core, ...bad } }) } };
  assert.equal(sourceTaskCoreForTurn(ctx, session, state, {}), null);
}
assert.equal(sourceTaskCoreForTurn({ sessionManager: { getTurnInputByTurnId() { throw Error('offline'); } } }, session, state, {}), null);
assert.equal(sourceTaskCoreForTurn({}, session, { admittedTurnInput: { ownerScope: 'owner' } }, { sourceTaskCore: core }), core, 'legacy supplied source remains available');
console.log('task source resolution passed');
