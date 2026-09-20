import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeRunnerFailure: normalize } = require('../src/main/runner-failure');
const { shouldRecoverParentClosure } = require('../src/main/parent-task-closure');
const { createTurnRecoveryRuntime } = require('../src/main/turn-recovery-runtime');
const { TurnOrchestrator } = require('../src/main/turn-orchestrator');
const { OpencodeAgentSession } = require('../src/main/opencode-agent-session');
const { rememberExecutionProgress, executionProgressKeys } = require('../src/main/task-execution-progress');

const native = 'Cannot connect to API: Unable to connect. Is the computer able to access the url?';
const engine = new OpencodeAgentSession('failure-progress');
let nativeFailure;
engine.bindOrchestrator({ notifyRunnerError: (...args) => { nativeFailure = args; } });
for (let i = 0; i < 3; i++) {
  rememberExecutionProgress(engine._turnGates.todo, { type: 'tool.started', payload: { id: String(i), name: 'read', input: { path: `source-${i}.txt` } } });
  rememberExecutionProgress(engine._turnGates.todo, { type: 'tool.done', payload: { id: String(i), content: `evidence-${i}` } });
}
const progressKeys = executionProgressKeys(engine._turnGates.todo);
assert.equal(progressKeys.length, 3);
const nativeCause = { name: 'APIError', data: { isRetryable: true } };
engine._turnSettled = false;
engine.busy = true;
engine._failTurn(native, nativeCause, { force: true });
assert.equal(nativeFailure[2], nativeCause, 'native cause survives the adapter');
assert.deepEqual(nativeFailure[3].executionProgressKeys, progressKeys, 'capture progress before clearing turn gates');
assert.deepEqual(executionProgressKeys(engine._turnGates.todo), [], 'next turn still starts with fresh progress');
engine.busy = true;
engine._turnSettled = false;
engine._onServerExit(4294967295);
assert.equal(normalize(nativeFailure[1], nativeFailure[2]).classified.code, 'ENGINE_UNAVAILABLE', 'Windows unsigned process exit is not HTTP 429');
for (const [message, cause, expected] of [
  [native, null, 'MODEL_CONNECTION_FAILED'],
  ['Transport failed', new Error('opaque failure', { cause: Object.assign(new Error('wire'), { code: 'ECONNRESET' }) }), 'MODEL_CONNECTION_FAILED'],
  ['Opaque failure', { details: { name: 'APIError', data: { message: 'opaque', isRetryable: true } } }, 'MODEL_CONNECTION_FAILED'],
  ['Opaque failure', { statusCode: 503 }, 'MODEL_CONNECTION_FAILED'],
  ['API Error: request failed', { statusCode: 429 }, 'RATE_LIMITED'],
  ['API Error: 502', { cause: { message: 'token refresh failed (401)' } }, 'UPSTREAM_MODEL_AUTH_FAILED'],
  ['fetch failed', { statusCode: 400 }, 'ENGINE_ERROR'],
  ['fetch failed', { details: { message: 'maximum context length exceeded' } }, 'CONTEXT_LIMIT'],
]) assert.equal(normalize(message, cause).classified?.code, expected);
assert.equal(normalize('fetch failed', { isRetryable: false }).classified.retryable, false);
assert.equal(normalize('Unknown engine failure', { isRetryable: true }).classified, null, 'bare boolean is not a network classification');
const cycle = { message: native, request: { headers: { authorization: 'SECRET' } } }; cycle.cause = cycle;
assert.equal(normalize('failure', cycle).classified.code, 'MODEL_CONNECTION_FAILED');
assert.ok(!normalize('failure', cycle).raw.includes('SECRET'), 'never collect request credentials');

const state = { turnId: 'source', enginePayload: { rawText: 'Finish the report' },
  taskContract: { active: true, taskType: 'document_work' },
  tools: new Map([['write', { id: 'write', name: 'write', status: 'running', input: { path: 'report.md' } }]]),
  pendingPermissions: new Map(), pendingQuestions: new Map(), pendingHooks: new Map() };
const payload = { failed: true, errorCode: 'MODEL_CONNECTION_FAILED', retryable: true };
const decision = extra => shouldRecoverParentClosure({ sessionId: 's', state, taskContract: state.taskContract, payload, ...extra });
assert.equal(decision().ok, true, 'one uncertain write qualifies for inspect-and-continue, not request replay');
assert.equal(decision({ state: { ...state, tools: new Map() } }).ok, false, 'zero-tool failures retain ordinary bounded retry');
assert.equal(decision({ payload: { ...payload, retryable: false } }).reason, 'NON_RETRYABLE_FAILURE');
assert.equal(decision({ payload: { ...payload, userInterrupted: true } }).reason, 'INTERRUPTED');
assert.equal(decision({ state: { ...state, pendingQuestions: new Map([['q', {}]]) } }).reason, 'WAITING_FOR_USER');
assert.equal(decision({ state: { ...state, currentPayload: { parentClosureRecovery: true } } }).reason, 'ALREADY_ATTEMPTED');

// Exercise the production terminal boundary, not just the classifier in isolation.
let terminal, prepared, recovered;
const host = { ctx: {}, _state: () => state,
  _finalize: (_id, type, value) => { terminal = { type, ...value }; },
  turnRecoveryRuntime: {
    prepareParentClosureRecovery: (_id, source) => { prepared = source; },
    afterParentClosureTerminal: (_id, source, options) => { recovered = { source, options }; },
  },
};
await TurnOrchestrator.prototype._handleError.call(host, 's', 'Opaque failure', { details: { name: 'APIError', data: { isRetryable: true } } }, { executionProgressKeys: progressKeys });
await new Promise(resolve => setImmediate(resolve));
assert.equal(terminal.errorCode, 'MODEL_CONNECTION_FAILED');
assert.equal(prepared.payload.retryable, true);
assert.deepEqual(prepared.payload.executionProgressKeys, progressKeys);
assert.deepEqual(terminal.executionProgressKeys, progressKeys);
assert.equal(recovered.options.failure.code, 'MODEL_CONNECTION_FAILED');
await TurnOrchestrator.prototype._handleError.call(host, 's', native, { isRetryable: false });
await new Promise(resolve => setImmediate(resolve));
assert.equal(terminal.retryable, false);
assert.equal(prepared.payload.retryable, false);

let sends = 0, fallback = 0, dispatchedOptions;
const runtime = createTurnRecoveryRuntime({ getState: () => ({ queue: [], tools: state.tools }),
  sendUserMessage: async (_id, _text, _files, options) => {
    sends++;
    dispatchedOptions = options;
    return { ok: true, turnId: options.turnId };
  } });
const source = { state, taskContract: state.taskContract, objective: 'Finish the report', payload };
const options = { failed: true, failure: { code: payload.errorCode }, selfHeal: async () => { fallback++; } };
try {
  const result = await runtime.afterParentClosureTerminal('s', source, options);
  assert.equal(result.ok, true, 'recovery actually dispatches, not merely attempts');
  assert.equal(dispatchedOptions.recovery.kind, 'parent_task_closure');
  assert.match(dispatchedOptions.recovery.guidance, /结果未知的写操作先核实/);
  await runtime.afterParentClosureTerminal('s', source, options);
  assert.equal(sends, 1, 'duplicate terminal dispatches one continuation');
  assert.equal(fallback, 0, 'owned recovery cannot also replay the original request');
  assert.equal(await runtime.maybeToolCallRescueRetry('s', { code: 'MODEL_CONNECTION_FAILED', retryable: false }), false);
} finally { runtime.disposeParentClosureRecovery(); }
console.log('runner failure contract passed');
