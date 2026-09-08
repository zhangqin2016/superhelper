import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTaskRunRuntime } = require('../src/main/task-run-runtime');
const { createTaskRun } = require('../src/main/task-run-state');
const { createTurnTerminalFinalizer } = require('../src/main/turn-terminal-finalizer');
const { shouldRecoverParentClosure } = require('../src/main/parent-task-closure');
async function scenario({ type = 'turn.completed', interrupted = false, unknown = false } = {}) {
  const state = { sessionId: 's', phase: 'running', turnId: 'acceptance', taskContract: { active: true, taskType: 'code_change', intentContract: { successCriteria: ['focused_test'] } }, taskRun: createTaskRun({ turnId: 'acceptance' }), enginePayload: { rawText: 'Implement and test the summary', files: [] }, tools: new Map([['edit', { name: 'edit', status: 'done' }]]), pendingPermissions: new Map(interrupted ? [['permission', {}]] : []), pendingQuestions: new Map(), pendingHooks: new Map(), timeline: [], notices: [], contentBlocks: [], blockIndexToToolId: new Map() };
  const prepared = [];
  const runtime = createTaskRunRuntime({ getState: () => state });
  const finalizer = createTurnTerminalFinalizer({ getState: () => state, taskRunRuntime: runtime,
    prepareParentClosureRecovery: (_session, source) => { assert.equal(state.turnId, 'acceptance', 'persist before cleanup'); prepared.push(source); },
    assessObjectiveCoverage: async () => unknown ? ({ status: 'unknown', requirements: [] }) : ({ status: 'missing', requirements: [{ title: 'focused_test', status: 'missing' }] }),
    turnArchive: { buildRecord: () => ({ artifacts: [], fileChanges: [], meta: {} }), commit: () => ({ id: 'record' }) } });
  const result = await finalizer.finalize('s', type, { assistant: 'Implementation done, not tested.' });
  return { state, result, prepared };
}
const outcome = await scenario();
assert.equal((await scenario({ unknown: true })).prepared.length, 0, 'generic unobserved criteria cannot invent an unfinished user obligation when the judge is unavailable');
assert.ok(outcome.result?.parentClosureSource, 'clean end with missing test returns an acceptance continuation');
assert.equal(outcome.prepared.length, 1);
assert.equal(outcome.state.turnId, null, 'normal terminal cleanup still runs');
const source = outcome.result.parentClosureSource;
assert.equal(source.payload.continuationHandoff.reason, 'acceptance_gap');
assert.ok(source.payload.continuationHandoff.unfinished.some(x => x.title.includes('focused_test')));
assert.equal(shouldRecoverParentClosure({ sessionId: 's', ...source }).ok, true);
assert.equal((await scenario({ type: 'turn.interrupted' })).prepared.length, 0);
assert.equal((await scenario({ interrupted: true })).prepared.length, 0, 'pending authorization is not auto-dispatched');
console.log('task acceptance recovery passed');

let releaseJudge;
const staleState = { sessionId: 's', turnId: 'old', tools: new Map(), pendingPermissions: new Map(), pendingQuestions: new Map(), pendingHooks: new Map(), taskRun: createTaskRun({ turnId: 'old' }), taskContract: { active: true, taskType: 'code_change' }, enginePayload: { rawText: 'test' }, timeline: [], notices: [], contentBlocks: [] };
const events = [];
staleState.tools.set('edit', { name: 'edit', status: 'done' });
const finalizer = createTurnTerminalFinalizer({ getState: () => staleState, emit: (...args) => events.push(args), assessObjectiveCoverage: () => new Promise(resolve => { releaseJudge = resolve; }) });
const pending = finalizer.finalize('s', 'turn.completed', { assistant: 'old' });
while (!releaseJudge) await new Promise(resolve => setImmediate(resolve));
staleState.turnId = 'new'; staleState.phase = 'running';
releaseJudge({ status: 'complete', requirements: [] });
await pending;
assert.equal(staleState.turnId, 'new', 'stale acceptance cannot clear the newer turn');
assert.equal(events.length, 0, 'stale acceptance cannot emit a newer state under the old terminal');
let releaseReconciliation;
staleState.turnId = 'before-reconcile'; staleState.finalizing = false;
const completed = [];
const reconciliationFinalizer = createTurnTerminalFinalizer({ getState: () => staleState, taskRunRuntime: { reconcilePlan: () => new Promise(resolve => { releaseReconciliation = resolve; }), complete: () => completed.push(staleState.turnId) } });
const reconciling = reconciliationFinalizer.finalize('s', 'turn.completed', { assistant: 'old' });
while (!releaseReconciliation) await new Promise(resolve => setImmediate(resolve));
staleState.turnId = 'after-reconcile';
releaseReconciliation(); await reconciling;
assert.deepEqual(completed, [], 'an older plan reconciliation cannot complete the newer task');
assert.equal(staleState.turnId, 'after-reconcile');

// Real durable store: finalizer's typed source survives a process restart and
// produces one hidden continuation, retaining the original objective.
const { MessageStore } = require('../src/main/store/message-store');
const { createTurnRecoveryRuntime } = require('../src/main/turn-recovery-runtime');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-restart-'));
let store = new MessageStore(path.join(scratch, 'messages.db'), path.join(scratch, 'blobs'));
try {
  const ownerScope = 'account:acceptance';
  const manager = {
    prepareParentClosureRecovery: (sessionId, input) => store.prepareParentClosureRecovery({ sessionId, ownerScope, ...input }),
    claimParentClosureRecovery: (sessionId, input) => store.claimParentClosureRecovery({ sessionId, ownerScope, ...input }),
    listPendingParentClosureRecoveries: sessionId => store.listPendingParentClosureRecoveries(sessionId, ownerScope),
    markParentClosureRecoveryDispatched: (sessionId, input) => store.markParentClosureRecoveryDispatched({ sessionId, ownerScope, ...input }),
    getTurnInputByTurnId: () => null,
  };
  const sent = [];
  const options = { ctx: { sessionManager: manager }, sendUserMessage: async (...args) => { sent.push(args); return { ok: true, turnId: args[3].turnId }; } };
  let recovery = createTurnRecoveryRuntime(options);
  const longObjective = source.objective + '\n' + 'Keep original requirements. '.repeat(70) + 'Deliver SECURITY.md.';
  assert.equal(recovery.prepareParentClosureRecovery('s', { ...source, objective: longObjective }).prepared, true);
  store.close(); store = new MessageStore(path.join(scratch, 'messages.db'), path.join(scratch, 'blobs'));
  recovery = createTurnRecoveryRuntime(options);
  assert.equal(await recovery.resumePendingParentClosures('s'), 1);
  assert.equal(await recovery.resumePendingParentClosures('s'), 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1], longObjective, 'restart preserves the full original request, not just its summary');
  assert.match(sent[0][3].recovery.guidance, /focused_test/);
  assert.equal(sent[0][3].recordUser, false);
} finally { store.close(); fs.rmSync(scratch, { recursive: true, force: true }); }

const { completeWithAcceptance } = require('../src/main/turn-acceptance-recovery');
for (const taskContract of [{ active: false }, { active: true, taskType: 'code_change' }]) {
  let coverage;
  completeWithAcceptance({ sessionId: 's', state: { turnId: 'missing', taskContract,
    taskRequest: { complete: false, reason: 'recovery_source_unavailable' }, tools: new Map() },
    type: 'turn.completed', payload: {}, taskRunRuntime: { complete: (_s, _t, opts) => { coverage = opts.objectiveCoverage; } },
    assess: () => { throw new Error('missing source must not call a model'); } });
  assert.equal(coverage?.status, 'unknown', 'no-tool and unclassified recovery must retain incomplete-source coverage');
}
const completedState = { ...source.state, taskContract: source.taskContract, taskRun: { verification: { status: 'verified', criteria: [] } } };
const legacyHandoff = { schemaVersion: 1, reason: 'budget_exhausted', progress: 2, unfinished: [{ title: 'remaining authorized acceptance' }] };
const preparedAfterAssessment = [];
const helperOptions = { sessionId: 's', state: completedState, type: 'turn.completed', payload: { continuationHandoff: legacyHandoff }, terminalPersisted: true, assess: async () => ({ status: 'complete', requirements: [] }), prepare: (_s, value) => preparedAfterAssessment.push(value) };
assert.equal(await completeWithAcceptance({ ...helperOptions, specializedRecovery: true }), null, 'specialized retry owns recovery without a second durable parent job');
assert.equal(preparedAfterAssessment.length, 0);
assert.deepEqual((await completeWithAcceptance(helperOptions)).payload.continuationHandoff, legacyHandoff, 'existing productive todo handoff survives acceptance integration');
assert.equal(preparedAfterAssessment.length, 1);
assert.equal(await completeWithAcceptance({ ...helperOptions, terminalPersisted: false }), null, 'lost terminal ownership cannot prepare automatic replay');
