import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring');
const { createCollaborationService } = require('../src/main/collaboration/service');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-social-'));
const options = { accountId: 'alice', dbPath: path.join(dir, 'cache.db'), keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys'), safeStorage: {
  isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
} }) };
const commands = [];
let mode = 'unknown';
let pending;
const client = {
  submitFriend: async (command) => { commands.push(command); if (mode === 'hang') return new Promise((r) => { pending = r; });
    if (mode === 'malformed') return { ok: true, result: { status: 'not-a-receipt' } };
    if (mode !== 'success') throw Object.assign(new Error('transport'), { code: mode === 'denied' ? 'COLLAB_FRIEND_TARGET_UNAVAILABLE' : 'COLLAB_RESPONSE_UNKNOWN' });
    return { ok: true, result: { status: 'pending', requestId: 'request' } }; },
  submitConversation: async (command) => { commands.push(command); if (mode === 'unknown') throw Object.assign(new Error('transport'), { code: 'COLLAB_RESPONSE_UNKNOWN' }); return { ok: true, result: { conversationId: 'created' } }; },
};
let store;
const create = (accountId = 'alice', deviceId = 'device') => {
  store = new CollaborationStore({ ...options, accountId });
  return createCollaborationService({ openStore: () => ({ ok: true, store }), client, deviceId, realtimeEnabled: false });
};
let service = create();
try {
  const command = { action: 'request', lilyId: 'bob-exact' };
  const first = await service.friend(command);
  assert.equal(first.state, 'confirming', 'unknown friend delivery is not reported as failure');
  assert.ok(first.clientCommandId, 'main owns a durable command identity');
  assert.equal(commands[0].clientCommandId, first.clientCommandId);
  assert.doesNotMatch(JSON.stringify(store.db.all('SELECT * FROM social_commands')), /bob-exact/, 'intent is encrypted at rest');
  service.stop(); service = create();
  const restored = service.getSocialCommands();
  assert.equal(restored.commands[0].clientCommandId, first.clientCommandId, 'pending identity is discoverable after restart');
  assert.equal((await service.friend(command)).clientCommandId, first.clientCommandId, 'same pending intent never gets a fresh key');
  mode = 'denied';
  assert.equal((await service.retrySocial({ clientCommandId: first.clientCommandId })).state, 'confirming', 'a rejected replay cannot disprove an earlier uncertain commit');
  mode = 'success';
  const completed = await service.retrySocial({ clientCommandId: first.clientCommandId });
  assert.equal(completed.state, 'completed');
  assert.equal(commands.at(-1).clientCommandId, first.clientCommandId);
  const count = commands.length;
  assert.equal((await service.retrySocial({ clientCommandId: first.clientCommandId })).state, 'completed');
  assert.equal(commands.length, count, 'a durable confirmed result is never resent');
  mode = 'denied';
  assert.equal((await service.friend({ action: 'request', lilyId: 'missing' })).state, 'failed', 'first definitive rejection is permanent');
  mode = 'unknown';
  const group = await service.conversation({ action: 'create', scopeType: 'personal', kind: 'group', title: 'Private title', memberUserIds: ['bob'] });
  service.stop(); service = create(); mode = 'success';
  assert.equal((await service.retrySocial({ clientCommandId: group.clientCommandId })).conversationId, 'created');
  assert.equal(commands.at(-1).clientCommandId, group.clientCommandId);
  mode = 'unknown';
  store.db.run("INSERT INTO directory_teams(account_id,id,scope_id,name,role) VALUES ('alice','org','team:org','Org','admin')");
  const team = await service.conversation({ action: 'create', scopeType: 'organization', organizationId: 'org', kind: 'channel', visibility: 'public' });
  assert.equal(service.getSocialCommands().commands.find((c) => c.clientCommandId === team.clientCommandId).scopeId, 'team:org', 'recovery view retains exact Team scope');
  store.revokeScope({ scopeId: 'team:org' });
  assert.equal(service.getSocialCommands().commands.some((c) => c.clientCommandId === team.clientCommandId), false, 'revocation purges scoped encrypted intents');
  assert.equal((await service.retrySocial({ clientCommandId: team.clientCommandId })).ok, false);
  service.stop(); service = create('other');
  assert.deepEqual(service.getSocialCommands().commands, [], 'other account cannot see intents');
  service.stop(); service = create(); mode = 'hang';
  const hanging = service.friend({ action: 'request', lilyId: 'late' });
  await new Promise((resolve) => setImmediate(resolve));
  service.stop(); pending({ ok: true, result: { status: 'pending' } });
  assert.equal((await hanging).code, 'COLLABORATION_STOPPED', 'late callback cannot touch closed store');
  service = create();
  assert.equal(service.getSocialCommands().commands.find((c) => c.input.lilyId === 'late').state, 'confirming', 'crash/restart preserves in-flight uncertainty');
  mode = 'malformed';
  assert.equal((await service.friend({ action: 'request', lilyId: 'invalid-response' })).state, 'confirming', 'arbitrary status text is not positive command evidence');
  const original = service.getSocialCommands().commands.find((c) => c.input.lilyId === 'invalid-response');
  service.stop(); service = create('alice', 'replacement-device'); mode = 'success';
  const beforeDeviceChange = commands.length;
  assert.equal((await service.retrySocial({ clientCommandId: original.clientCommandId })).code, 'COLLAB_DEVICE_CHANGED');
  assert.equal(commands.length, beforeDeviceChange, 'a new device cannot replay the old device-scoped command receipt identity');
  console.log('collaboration social journal passed (real SQLite restart/encryption)');
} finally { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
