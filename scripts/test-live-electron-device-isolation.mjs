import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
if (process.platform !== 'darwin') {
  console.log('SKIP: full-app virtual hardware acceptance adapter is macOS-only.');
  process.exit(0);
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-virtual-devices-'));
const source = fs.readFileSync(new URL('./remote-task-live-electron.cjs', import.meta.url), 'utf8');
const begin = source.indexOf('  // Virtual acceptance device identity');
const end = source.indexOf('  // End virtual acceptance device identity', begin);
const initialize = begin < 0 ? '' : source.slice(begin, end);
try {
  const results = [];
  for (const index of [0, 1]) {
    const userData = path.join(temporary, String(index)); fs.mkdirSync(userData);
    const child = spawnSync(process.execPath, ['-e', `
      const fs = require('node:fs'), path = require('node:path');
      const userData = process.env.LILY_USER_DATA_DIR;
      ${initialize}
      if (require('node:child_process').execSync('printf acceptance-probe', { encoding: 'utf8' }) !== 'acceptance-probe') throw new Error('unrelated command altered');
      const service = require('./src/main/service-client');
      const first = service.devicePayload(), again = service.devicePayload();
      if (first.deviceId !== again.deviceId || first.publicKey !== again.publicKey) throw new Error('unstable device');
      process.stdout.write(JSON.stringify({ deviceId: first.deviceId, fingerprintHash: first.fingerprintHash, keyHash: require('node:crypto').createHash('sha256').update(first.publicKey).digest('hex') }));
    `], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, LILY_USER_DATA_DIR: userData, LILY_HOME: temporary, LILY_DOCUMENTS_DIR: temporary }, encoding: 'utf8' });
    assert.equal(child.status, 0, 'offline real service identity generation must succeed');
    results.push(JSON.parse(child.stdout));
  }
  assert(results[0].deviceId !== results[1].deviceId, 'two same-host acceptance profiles must not register different public keys under the same machine device ID');
  assert(results[0].fingerprintHash !== results[1].fingerprintHash, 'virtual fingerprints must not trigger shared physical-device license recovery');
  assert.notEqual(results[0].keyHash, results[1].keyHash, 'each virtual device must retain an independent signing key');
  assert(results.every(result => result.deviceId.startsWith('dev_')));
  console.log('Full-app acceptance profiles: distinct production-derived virtual IDs/fingerprints and independent real service signing keys, no network.');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
