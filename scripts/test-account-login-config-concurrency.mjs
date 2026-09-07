import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-login-refresh-'));
process.env.LILY_USER_DATA_DIR = temporary;
process.env.LILY_HOME = temporary;
process.env.LILY_DOCUMENTS_DIR = temporary;
const remote = require('../src/main/remote-config');
const { refreshRemoteConfigForSend } = require('../src/main/ipc-utils');
const original = remote.refreshRemoteConfig;
const turns = [];
remote.refreshRemoteConfig = ({ reason }) => new Promise(resolve => turns.push({ reason, resolve }));
const tick = () => new Promise(resolve => setImmediate(resolve));
try {
  const anonymous = refreshRemoteConfigForSend({ force: true, timeoutMs: 5000 });
  await tick();
  assert.equal(turns.length, 1);
  const login = refreshRemoteConfigForSend({ force: true, reason: 'account_login', timeoutMs: 5000 });
  const ordinary = refreshRemoteConfigForSend({ force: true, timeoutMs: 5000 });
  await tick();
  assert.equal(turns.length, 1, 'login refresh must wait for prior config writes before requesting current account');
  turns[0].resolve({ ok: true, policy: 'anonymous' });
  await tick();
  assert.equal(turns.length, 2, 'login must request fresh scoped config rather than reuse anonymous result');
  assert.equal(turns[1].reason, 'account_login');
  const another = refreshRemoteConfigForSend({ force: true, timeoutMs: 5000 });
  await tick();
  assert.equal(turns.length, 2, 'completion of old refresh must not clear the queued refresh single-flight slot');
  turns[1].resolve({ ok: true, policy: 'signed-in' });
  assert.equal((await anonymous).policy, 'anonymous');
  for (const result of await Promise.all([login, ordinary, another])) assert.equal(result.policy, 'signed-in');

  const send = refreshRemoteConfigForSend({ force: true, timeoutMs: 5000 });
  const peer = refreshRemoteConfigForSend({ force: true, timeoutMs: 5000 });
  await tick();
  assert.equal(turns.length, 3, 'ordinary callers still share one network refresh');
  turns[2].resolve({ ok: true });
  assert.equal((await send).ok, true); assert.equal((await peer).ok, true);
  console.log('Real config refresh helper: account login queues after anonymous refresh; ordinary callers retain single-flight.');
} finally {
  for (const turn of turns) turn.resolve({ ok: false });
  remote.refreshRemoteConfig = original;
  fs.rmSync(temporary, { recursive: true, force: true });
}
