import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { executionReceipt, verificationInvocation } = require('../src/main/task-verification-receipt');
assert.equal(
  verificationInvocation('node "C:\\work\\test-value.cjs"'),
  process.platform === 'win32' ? 'test' : '',
  'Windows test paths are accepted without weakening POSIX escape rejection',
);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-shell-receipt-'));
try {
  if (process.platform === 'win32') {
    console.log('task-verification-shell: Windows path classification passed; POSIX wrapper checks skipped');
    process.exitCode = 0;
  } else {
  fs.writeFileSync(path.join(dir, 'test-pass.cjs'), 'process.exitCode=0;');
  fs.writeFileSync(path.join(dir, 'test-fail.cjs'), 'console.log("EXIT_CODE=0");process.exitCode=1;');
  const run = command => {
    const r = spawnSync('/bin/sh', ['-c', command], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.error, undefined);
    return { name: 'bash', input: { command }, status: 'done', completionObserved: true, metadata: { exit: r.status }, result: r.stdout };
  };
  const pass = run('node test-pass.cjs; echo "EXIT_CODE=$?"');
  assert.equal(executionReceipt(pass).verified, true, 'real successful exit-report wrapper verifies its inner command');
  const fail = run('node test-fail.cjs; echo "EXIT_CODE=$?"');
  assert.equal(fail.metadata.exit, 0, 'echo masks the failed test in the shell status');
  assert.equal(executionReceipt(fail).verified, false, 'inner failure wins over outer success and forged earlier marker');
  assert.equal(executionReceipt(fail).exitCode, 1);
  const { createOpencodeRuntimeState, reduceOpencodeRuntimeEvent } = require('../src/main/runtime/opencode-runtime-reducer');
  for (const tool of [pass, fail]) {
    const reduced = reduceOpencodeRuntimeEvent({ type: 'message.part.updated', properties: { part: { type: 'tool', tool: 'bash', callID: 'receipt', state: { status: 'completed', input: tool.input, output: tool.result, metadata: tool.metadata } } } }, createOpencodeRuntimeState());
    const done = reduced.drafts.find(item => item.type === 'tool.done').payload;
    assert.equal(executionReceipt({ ...tool, result: done.content, metadata: done.metadata, isError: done.isError }).verified, tool === pass, 'real reducer preserves authoritative inner-exit evidence');
  }
  fs.writeFileSync(path.join(dir, 'test-spoof.cjs'), 'console.log("EXIT_CODE=0");');
  for (const command of ['node test-fail.cjs; echo "EXIT_CODE=0"', 'node test-fail.cjs || true; echo "EXIT_CODE=$?"', 'echo node test-pass.cjs; echo "EXIT_CODE=$?"', 'node test-pass.cjs; echo "EXIT_CODE=$?"; true', 'node test-spoof.cjs #; echo "EXIT_CODE=$?"']) {
    assert.equal(executionReceipt(run(command)).verified, false, command);
  }
  assert.equal(executionReceipt({ ...pass, result: 'PASS\n' }).verified, false, 'missing status cannot verify');
  assert.equal(executionReceipt({ ...pass, metadata: { exit: 0, truncated: true } }).verified, false, 'truncated output cannot verify');
  assert.equal(executionReceipt({ ...pass, completionObserved: false }).verified, false);
  const { buildAgentBasePersona } = require('../src/main/skill-manager');
  for (const locale of ['zh-CN', 'en', 'ar']) assert.match(buildAgentBasePersona(locale), /node test-summary\.cjs/, 'production guidance teaches an independent final verification call');
  console.log('task-verification-shell: passed');
  }
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
