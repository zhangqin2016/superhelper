import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTaskRun, addTaskEvidence, buildTaskToolEvidence, assessTaskVerification, completeTaskRun } = require('../src/main/task-run-state');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-completion-'));
try {
  const run = createTaskRun({ turnId: 'multistage' });
  const source = path.join(dir, 'value.cjs'), check = path.join(dir, 'test-value.cjs');
  fs.writeFileSync(check, "require('node:assert/strict').equal(require('./value.cjs'), 42);\n");
  function edit(value) {
    fs.writeFileSync(source, `module.exports = ${value};\n`);
    addTaskEvidence(run, buildTaskToolEvidence({ name: 'edit', status: 'done', completionObserved: true, input: { filePath: source } }));
  }
  function test() {
    const result = spawnSync(process.execPath, [check], { encoding: 'utf8' });
    assert.equal(result.error, undefined);
    addTaskEvidence(run, buildTaskToolEvidence({ name: 'bash', input: { command: `node "${check}"` }, status: 'done', completionObserved: true, metadata: { exit: result.status } }));
    return result.status;
  }
  const assess = extra => assessTaskVerification({ taskType: 'code_change', successCriteria: ['focused_test'], evidence: run.evidence, ...extra });
  edit(42); assert.equal(test(), 0); assert.equal(assess().status, 'verified');
  edit(0); assert.notEqual(assess().status, 'verified');
  assert.notEqual(test(), 0); assert.notEqual(assess().status, 'verified');
  edit(42); assert.equal(test(), 0); assert.equal(assess().status, 'verified');
  const deliverable = path.join(dir, 'delivery.txt');
  assert.equal(assess({ deliverables: [deliverable] }).status, 'unverified');
  fs.writeFileSync(deliverable, 'Delivered result: 42\n');
  assert.equal(assess({ deliverables: [deliverable], artifacts: [{ path: deliverable }] }).status, 'observed', 'existence is not semantic quality');
  run.plan = [{ id: 'todo_1', title: 'implementation', status: 'completed' }, { id: 'todo_2', title: 'acceptance', status: 'pending' }];
  completeTaskRun(run, 'turn.completed', assess());
  assert.equal(run.verification.status, 'unverified');
  assert.equal(run.progress.value, 0.5);
  assert.equal(run.plan[1].status, 'pending');
  console.log('task completion multistage: actual file/process acceptance passed');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
