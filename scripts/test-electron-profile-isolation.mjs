import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lily-profile-lock-')));
const children = [];
async function launch(override) {
  const env = { ...process.env, LILY_LOCK_TEST_APP_DATA: temporary };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.LILY_USER_DATA_DIR;
  if (override !== undefined) env.LILY_USER_DATA_DIR = override;
  const child = spawn(electron, ['scripts/fixtures/electron-profile-lock.cjs'], { cwd: path.resolve(import.meta.dirname, '..'), env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timer = setTimeout(() => reject(new Error(`Electron profile host timed out: ${stderr}`)), 15000);
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.stdout.on('data', bytes => {
      stdout += bytes;
      const match = stdout.match(/LILY_LOCK_RESULT (.*)\n/);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { if (!stdout.includes('LILY_LOCK_RESULT')) { clearTimeout(timer); reject(new Error(`Electron profile host exited ${code}: ${stderr}`)); } });
  });
}
try {
  const firstPath = path.join(temporary, 'first'), secondPath = path.join(temporary, 'second');
  fs.mkdirSync(firstPath); fs.mkdirSync(secondPath);
  const first = await launch(firstPath);
  assert.equal(first.userData, firstPath, 'explicit profile must control Electron before its lock');
  assert.equal(first.acquired, true);
  const second = await launch(secondPath);
  assert.equal(second.userData, secondPath); assert.equal(second.acquired, true, 'different profiles must run concurrently');
  const duplicate = await launch(firstPath);
  assert.equal(duplicate.acquired, false, 'same profile must retain single-instance protection');
  const relative = await launch('relative-profile');
  assert.match(relative.error || '', /LILY_USER_DATA_DIR.*absolute/, 'invalid overrides must fail before taking a shared default lock');
  const empty = await launch('');
  assert.match(empty.error || '', /LILY_USER_DATA_DIR.*absolute/);
  const defaultProfile = await launch();
  assert.equal(defaultProfile.userData, path.join(temporary, 'lily-workbench'));
  assert.equal(defaultProfile.acquired, true);
  const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert(source.indexOf('app.setPath("userData"') < source.indexOf('bindRuntimePaths('));
  assert(source.indexOf('bindRuntimePaths(') < source.indexOf('app.requestSingleInstanceLock('));
  console.log('Real Electron: separate profile locks, duplicate refusal, invalid override rejection and stable default passed.');
} finally {
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.stdin.end('quit\n');
  })));
  fs.rmSync(temporary, { recursive: true, force: true });
}
