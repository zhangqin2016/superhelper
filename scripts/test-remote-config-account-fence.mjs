import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-config-account-'));
process.env.LILY_USER_DATA_DIR = temporary;
process.env.LILY_HOME = temporary;
process.env.LILY_DOCUMENTS_DIR = temporary;
const keys = crypto.generateKeyPairSync('ed25519');
process.env.LILY_CONFIG_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' });
const { stableStringify } = require('../src/main/crypto-signing');
const remote = require('../src/main/remote-config');
const service = require('../src/main/service-client');
const account = require('../src/main/account-manager');
const original = { fetch: service.fetchClientConfig, status: account.accountStatus, token: account.accessTokenForService };
let principal = '', pendingToken;
const requests = [];
account.accountStatus = () => ({ loggedIn: Boolean(principal), user: principal ? { id: principal } : null });
account.accessTokenForService = () => pendingToken || Promise.resolve(principal ? { ok: true, accessToken: `fixture-${principal}` } : { ok: false });
service.fetchClientConfig = input => new Promise(resolve => requests.push({ input, resolve }));
const tick = () => new Promise(resolve => setImmediate(resolve));
function response(version) {
  const payload = { schemaVersion: 1, configVersion: version, expiresAt: new Date(Date.now() + 60000).toISOString(), effectiveConfig: { marker: version } };
  return { ok: true, json: { ...payload, signature: crypto.sign(null, Buffer.from(stableStringify(payload)), keys.privateKey).toString('base64url') } };
}
try {
  const anonymous = remote.refreshRemoteConfig(); await tick();
  principal = 'alice';
  const signedIn = remote.refreshRemoteConfig(); await tick();
  requests[1].resolve(response('alice')); assert.equal((await signedIn).ok, true);
  requests[0].resolve(response('anonymous'));
  assert.deepEqual(await anonymous, { ok: false, error: 'ACCOUNT_SESSION_CHANGED' }, 'late anonymous config must never overwrite signed-in policy');
  assert.equal(remote.getRemoteEffectiveConfigSync().marker, 'alice');
  const oldAccount = remote.refreshRemoteConfig(); await tick();
  principal = 'bob';
  requests[2].resolve(response('old-alice'));
  assert.equal((await oldAccount).error, 'ACCOUNT_SESSION_CHANGED');
  assert.equal(remote.getRemoteEffectiveConfigSync().marker, 'alice', 'discard leaves the existing baseline untouched');
  let releaseToken;
  pendingToken = new Promise(resolve => { releaseToken = resolve; });
  const changingToken = remote.refreshRemoteConfig(); await tick();
  principal = 'charlie'; releaseToken({ ok: true, accessToken: 'fixture-bob' });
  assert.equal((await changingToken).error, 'ACCOUNT_SESSION_CHANGED', 'principal switch while obtaining token must stop before issuing config request');
  assert.equal(requests.length, 3);
  pendingToken = null; principal = '';
  const baseline = remote.refreshRemoteConfig(); await tick();
  requests[3].resolve(response('anonymous-baseline'));
  assert.equal((await baseline).ok, true, 'stable anonymous startup remains supported');
  console.log('Real signed config: late anonymous/account responses fenced; token-race fenced; anonymous baseline preserved.');
} finally {
  for (const request of requests) request.resolve({ ok: false });
  service.fetchClientConfig = original.fetch; account.accountStatus = original.status; account.accessTokenForService = original.token;
  fs.rmSync(temporary, { recursive: true, force: true });
}
