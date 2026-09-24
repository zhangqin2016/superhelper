import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const coverageModule = require('../src/main/task-original-acceptance');
assert.equal(typeof coverageModule.assessObjectiveCoverage, 'function', 'original objective must be audited independently of completed todos');
const state = { taskContract: { active: true, taskType: 'code_change' }, taskCore: { contract: { objective: 'Build summary and test it; deliver REPORT.md' } }, taskRun: { plan: [{ title: 'Build summary', status: 'completed' }], planSync: { tools: [{ name: 'bash', ok: true, running: false, inputText: 'node test-summary.cjs', outputText: '7 tests passed' }] } } };
state.tools = new Map([['test', { name: 'bash', status: 'done', completionObserved: true, input: { command: 'node test-summary.cjs' }, result: '7 tests passed', metadata: { exit: 0 } }]]);
state.taskRun.planSync.tools = []; // Final todowrite clears this inference window.
const verdict = { exhaustive: true, requirements: [{ requirementQuote: 'Build summary and test it', status: 'complete', evidenceId: 'E1', evidenceQuote: '7 tests passed' }, { requirementQuote: 'deliver REPORT.md', status: 'missing' }] };
let prompt;
const judge = raw => coverageModule.assessObjectiveCoverage({ state, resolveConnection: () => ({ connection: {} }), post: async options => { prompt = options.prompt; assert.ok(options.liveness && typeof options.liveness === 'object', 'judged by liveness: a slow reply still arriving is not a failure'); assert.equal(options.timeoutMs, undefined, 'and no fixed deadline that measures the model\'s speed'); return JSON.stringify(raw); } });
assert.equal((await judge(verdict)).status, 'missing');
assert.ok(prompt.includes('deliver REPORT.md'), 'original requirement omitted from todo is still reviewed');
assert.equal((await judge({ ...verdict, requirements: [{ requirementQuote: 'invented deployment', status: 'missing' }] })).status, 'unknown', 'judge cannot invent authority');
assert.equal((await judge({ ...verdict, requirements: [{ requirementQuote: 'Build summary and test it', status: 'complete', evidenceId: 'E1', evidenceQuote: 'all done' }] })).status, 'unknown', 'fabricated evidence rejected');
assert.equal((await judge({ ...verdict, exhaustive: false })).status, 'unknown');
assert.equal((await coverageModule.assessObjectiveCoverage({ state, resolveConnection: () => ({ reason: 'offline' }) })).status, 'unknown');
assert.equal((await coverageModule.assessObjectiveCoverage({ state, resolveConnection: () => ({ connection: {} }), post: async () => { throw Error('timeout'); } })).status, 'unknown');
const shell = state.tools.get('test');
shell.input.command = 'node test-summary.cjs; echo "EXIT_CODE=$?"';
shell.result = '7 tests passed\nEXIT_CODE=1\n';
assert.equal((await judge({ exhaustive: true, requirements: [verdict.requirements[0]] })).status, 'unknown', 'failed wrapper inner command cannot prove completion');
shell.result = '7 tests passed\nEXIT_CODE=0\n'; shell.metadata = { exitCode: 1 };
assert.equal((await judge({ exhaustive: true, requirements: [verdict.requirements[0]] })).status, 'unknown', 'outer failure alias cannot prove completion');
const fullRequest = 'Implement the summary. '.repeat(70) + 'Also deliver SECURITY.md.';
state.taskCore.contract.objective = fullRequest.slice(0, 1000);
state.enginePayload = { rawText: fullRequest };
assert.ok(coverageModule.originalAcceptance(state).objective.includes('deliver SECURITY.md'), 'full original instruction survives the contract summary limit');
// ---------------------------------------------------------------------------
// The audit runs on the connection the WORK ran on, and an audit that cannot
// run is never silent. Both were true only by accident before 2026-09-22: the
// coverage caller resolved the active preset (the judge resolver's modelRoute
// parameter exists exactly for this), and "unknown" looked the same whether the
// judge had ruled or had never been reachable.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = name => fs.readFileSync(path.join(root, 'src', 'main', name), 'utf8');
const observability = require('../src/main/objective-coverage-observability');
const judgeModule = require('../src/main/evidence-entailment-judge');

// Earlier checks deliberately spoiled the objective and the evidence shape;
// restore the passing turn so what follows measures the audit, not the fixture.
state.taskCore.contract.objective = 'Build summary and test it; deliver REPORT.md';
delete state.enginePayload;
state.tools = new Map([['test', { name: 'bash', status: 'done', completionObserved: true, input: { command: 'node test-summary.cjs' }, result: '7 tests passed', metadata: { exit: 0 } }]]);
state.sessionId = 'session-1';
state.turnId = 'turn-9';
state.turnModelRoute = { selectionId: 'sel-1', modelId: 'm-1', providerId: 'p-1' };

{
  const seen = [];
  await coverageModule.assessObjectiveCoverage({
    state,
    resolveConnection: route => { seen.push(route); return { connection: {} }; },
    post: async () => JSON.stringify(verdict),
  });
  assert.deepEqual(seen[0], state.turnModelRoute, 'the audit is resolved on the turn own route, not the active preset');
}

{
  // The turn model is gone (unpinned, removed from the catalog). Losing the
  // audit entirely is worse than auditing on the active preset, which is what
  // every audit used before the route existed.
  const calls = [];
  const result = await coverageModule.assessObjectiveCoverage({
    state,
    resolveConnection: route => { calls.push(route); return route ? { reason: 'turn_model_unavailable' } : { connection: {} }; },
    post: async () => JSON.stringify(verdict),
  });
  assert.deepEqual(calls, [state.turnModelRoute, null], 'an unresolvable route degrades to the baseline connection');
  assert.equal(result.status, 'missing', 'and the audit still produces a verdict');
}

assert.equal(typeof judgeModule.resolveAuditConnection, 'function', 'the audit connection rule lives in one place');
{
  const routed = judgeModule.resolveAuditConnection({ modelRoute: { selectionId: 's' }, resolve: () => ({ connection: { model: 'a' } }) });
  assert.deepEqual(routed, { connection: { model: 'a' }, reason: '', routed: true }, 'which of the two connections was used stays observable');
  const dead = judgeModule.resolveAuditConnection({ modelRoute: { selectionId: 's' }, resolve: () => ({ connection: null, reason: 'api_key_missing' }) });
  assert.equal(dead.connection, null);
  assert.equal(dead.reason, 'api_key_missing', 'and the reason survives for the report');
  assert.equal(dead.routed, false);
  const unrouted = judgeModule.resolveAuditConnection({ resolve: route => { assert.equal(route, null); return { connection: { model: 'b' } }; } });
  assert.equal(unrouted.routed, false, 'a turn with no recorded route is the baseline case, not a failure');
}

{
  // Every declined audit is reported; only a turn that had nothing to audit is
  // quiet. The benign list is closed, so a reason invented later is LOUD by
  // default rather than silent by default.
  const reports = [];
  const warnings = [];
  let clock = 0;
  const observe = observability.createCoverageObserver({
    report: async payload => { reports.push(payload); },
    logger: { warn: message => warnings.push(message) },
    now: () => clock,
    cooldownMs: 1000,
  });
  // Reporting is deliberately fire-and-forget so it can never delay a turn;
  // the test lets that microtask land before counting.
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const run = async resolveConnection => {
    const result = await coverageModule.assessObjectiveCoverage({ state, resolveConnection, observe });
    await flush();
    return result;
  };

  assert.equal((await run(() => ({ reason: 'api_key_missing' }))).status, 'unknown');
  assert.equal(reports.length, 1, 'a judge that cannot be reached is reported');
  assert.equal(reports[0].eventSubtype, 'objective_coverage_unavailable');
  assert.equal(reports[0].trace.cause, 'api_key_missing');
  assert.equal(reports[0].trace.turnId, 'turn-9', 'with the turn it happened on');
  assert.equal(reports[0].trace.routed, true, 'and whether the turn route was usable');
  assert.equal(reports[0].severity, 'warning', 'observation never escalates a verdict');
  assert.ok(warnings.length >= 1, 'and it is always written to the local log first');

  await run(() => ({ reason: 'api_key_missing' }));
  assert.equal(reports.length, 1, 'a permanently broken judge reports once per cause, not once per turn');
  assert.ok(warnings.length >= 2, 'though every occurrence is still logged locally');
  clock = 5000;
  await run(() => ({ reason: 'api_key_missing' }));
  assert.equal(reports.length, 2, 'and again after the cooldown, so a lasting outage keeps being visible');

  await run(() => ({ reason: 'a_reason_nobody_has_written_yet' }));
  assert.equal(reports.length, 3, 'an unrecognised reason is reported — silence is never the default a new branch inherits');

  const before = reports.length;
  const nothingRan = { ...state, tools: new Map() };
  assert.equal((await coverageModule.assessObjectiveCoverage({ state: nothingRan, observe })).status, 'unknown');
  await flush();
  assert.equal(reports.length, before, 'a turn that ran nothing had nothing to audit and is not an outage');

  const noContract = { ...state, taskContract: null };
  await coverageModule.assessObjectiveCoverage({ state: noContract, observe });
  await flush();
  assert.equal(reports.length, before, 'and neither is a turn with no execution intent');

  // A verdict the judge DID rule on, leaving one requirement unproven, is the
  // organ working — reporting that as an outage would bury the real ones.
  const ruled = await coverageModule.assessObjectiveCoverage({
    state,
    resolveConnection: () => ({ connection: {} }),
    post: async () => JSON.stringify({ exhaustive: true, requirements: [{ requirementQuote: 'deliver REPORT.md', status: 'unknown' }] }),
    observe,
  });
  assert.equal(ruled.status, 'unknown');
  await flush();
  assert.equal(reports.length, before, 'an inconclusive verdict is not an unavailable audit');
}

{
  // Observation may never change a verdict, so a reporter that throws, and a
  // transport that rejects, both leave the audit exactly as it was.
  const exploding = observability.createCoverageObserver({
    report: () => { throw new Error('diagnostics offline'); },
    logger: { warn: () => { throw new Error('log offline'); } },
  });
  const result = await coverageModule.assessObjectiveCoverage({ state, resolveConnection: () => ({ reason: 'offline' }), observe: exploding });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'offline');
}

// Structural: every `state.X` these two modules read must be a field the turn
// state actually carries. The 2026-09-21 lesson — a gate that read two invented
// field names could never fire in production, and unit tests passed because the
// fake session had them.
{
  const orchestrator = readSrc('turn-orchestrator.js');
  const literal = /_state\(sessionId\) \{[\s\S]*?\n      \};/.exec(orchestrator);
  assert.ok(literal, 'the turn state literal must be findable for this check to mean anything');
  const declared = new Set([...literal[0].matchAll(/^ {8}([A-Za-z_][A-Za-z0-9_]*)[,:]/gm)].map(m => m[1]));
  const assigned = new Set();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        for (const m of fs.readFileSync(full, 'utf8').matchAll(/state\.([A-Za-z_][A-Za-z0-9_]*) =/g)) assigned.add(m[1]);
      }
    }
  };
  walk(path.join(root, 'src', 'main'));
  const read = new Set();
  for (const name of ['task-original-acceptance.js', 'objective-coverage-observability.js']) {
    for (const m of readSrc(name).matchAll(/state\.([A-Za-z_][A-Za-z0-9_]*)/g)) read.add(m[1]);
  }
  const invented = [...read].filter(name => !declared.has(name) && !assigned.has(name));
  assert.deepEqual(invented, [], `the audit reads turn-state fields that nothing sets: ${invented.join(', ')}`);
  assert.ok(read.has('turnModelRoute'), 'including the route the audit now depends on');
}

// Structural: no end-of-turn audit may resolve a connection while ignoring the
// route the turn ran on. Each of these three had it available and dropped it.
{
  assert.match(readSrc('task-original-acceptance.js'), /resolveAuditConnection\(\{\s*modelRoute: state\.turnModelRoute/, 'coverage audits on the turn route');
  assert.match(readSrc('todo-plan-reconciler.js'), /resolveAuditConnection\(\{\s*modelRoute,/, 'plan reconciliation audits on the turn route');
  assert.match(readSrc('task-run-runtime.js'), /reconcilePlanWithModel\(\{ taskRun: state\.taskRun, modelRoute: state\.turnModelRoute/, 'and its call site hands the route down');
  assert.match(readSrc('evidence-entailment-judge.js'), /resolveAuditConnection\(\{ modelRoute \}\)/, 'the semantic judge audits on the turn route');
  assert.match(readSrc('answer-evidence-finalizer.js'), /judgeFn\(\{[^}]*modelRoute: params_\.modelRoute/, 'and the finalizer stops dropping it on the way in');
  assert.match(readSrc('document-delivery-response.js'), /resolveAuditConnection\(\{ modelRoute, resolve: adapters\.resolveConnection \}\)/, 'and so does document-delivery classification');

  // One seam, kept by construction: the raw resolver is the audit resolver's
  // own business. Anything else naming it is a second connection policy, which
  // is how this one drifted out of sync in the first place.
  const offenders = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && entry.name !== 'evidence-entailment-judge.js'
        && /resolveJudgeConnectionDetailed/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(root, full));
    }
  };
  walk(path.join(root, 'src', 'main'));
  assert.deepEqual(offenders, [], `end-of-turn audits must resolve through resolveAuditConnection: ${offenders.join(', ')}`);
}

// ---------------------------------------------------------------------------
// The audit that never ran (2026-09-23/24): 7 of 7 judged turns failed at
// 10.8s — a 10s bound where every sibling audit waits 30s — and the cause was
// discarded, so the log said only "Unexpected end of JSON input".
{
  const swallowed = require('../src/main/diagnostics/swallowed-failure');
  const judgeModule = require('../src/main/evidence-entailment-judge');
  const warn = console.warn; const lines = []; console.warn = (...args) => lines.push(args.join(' '));
  try {
    swallowed.resetSwallowedFailuresForTests();
    // Its own state: the sections above mutate the shared one.
    const shell = { name: 'bash', status: 'done', completionObserved: true, input: { command: 'node test-summary.cjs' }, result: '7 tests passed', metadata: { exit: 0 } };
    const state = {
      taskContract: { active: true, taskType: 'code_change' },
      taskCore: { contract: { objective: 'Build summary and test it; deliver REPORT.md' } },
      taskRun: { plan: [{ title: 'Build summary', status: 'completed' }], planSync: { tools: [] } },
      tools: new Map([['test', shell]]),
    };
    const timedOut = await coverageModule.assessObjectiveCoverage({
      state, resolveConnection: () => ({ connection: {} }),
      post: async ({ diagnostics }) => { diagnostics.reason = 'timeout_30000ms'; return ''; },
    });
    assert.equal(timedOut.status, 'unknown', 'an audit that could not run still claims nothing');
    assert.equal(timedOut.reason, 'judge_unavailable:timeout_30000ms', 'and says WHY, in cause:detail form');
    assert.ok(lines.some(line => /objective coverage audit/.test(line) && /timeout_30000ms/.test(line)), 'the log names the real cause');
    assert.ok(!lines.some(line => /Unexpected end of JSON input/.test(line)), 'not the parse error it used to collapse into');
    assert.equal(judgeModule.auditTimeoutMs({}), 30000);
    assert.equal(judgeModule.auditTimeoutMs({ LILY_EVIDENCE_JUDGE_TIMEOUT_MS: '45000' }), 45000, 'one knob for every end-of-turn audit');

    // A thinking model's reply: prose, a fenced verdict, and a quoted output
    // that is itself JSON — braces inside strings must not break the parse.
    shell.result = '{"passed": 7, "note": "a } b"} 7 tests passed';
    const wrapped = await coverageModule.assessObjectiveCoverage({
      state, resolveConnection: () => ({ connection: {} }),
      post: async () => 'Checking each requirement.\n```json\n' + JSON.stringify({ exhaustive: true, requirements: [
        { requirementQuote: 'Build summary and test it', status: 'complete', evidenceId: 'E1', evidenceQuote: '{"passed": 7, "note": "a } b"}' },
        { requirementQuote: 'deliver REPORT.md', status: 'missing' },
      ] }) + '\n```\nDone.',
    });
    assert.equal(wrapped.status, 'missing', 'a verdict wrapped in prose and fences is still read');
    assert.equal(wrapped.requirements[0].evidenceQuote, '{"passed": 7, "note": "a } b"}');

    const garbage = await coverageModule.assessObjectiveCoverage({ state, resolveConnection: () => ({ connection: {} }), post: async () => 'I could not decide.' });
    assert.equal(garbage.reason, 'verdict_unparseable', 'a reply with no verdict is named as that, not as the judge being down');
  } finally { console.warn = warn; }
}

console.log('task objective coverage passed');
