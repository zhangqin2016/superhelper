import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCollaborationIpc } = require('../src/main/ipc-collaboration');
const handlers = new Map(), calls = [];
let current = { ok: true,
  conversation: async (input) => { calls.push(input); return { ok: true, state: 'completed', conversationId: 'c', token: 'SECRET' }; },
  friend: async (input) => { calls.push(input); return { ok: false, state: 'failed', clientCommandId: 'cmd', code: 'COLLAB_FRIEND_TARGET_UNAVAILABLE', token: 'SECRET' }; },
  getSocialCommands: () => ({ ok: true, commands: [{ kind: 'friend', input: { action: 'request', lilyId: 'exact-id' }, clientCommandId: 'stable', state: 'confirming', token: 'SECRET' }] }),
  getConversationDetails: () => ({ ok: true, conversation: { id: 'c', scopeId: 'team:org', kind: 'channel', title: 'Team' }, visibility: 'private', canManage: true,
    members: [{ userId: 'u', displayName: 'Name', role: 'owner', email: 'SECRET' }], key: 'SECRET' }),
  openFriend: () => ({ ok: true, conversationId: 'canonical' }),
  retrySocial: () => ({ ok: true, state: 'confirming', clientCommandId: 'stable' }),
};
createCollaborationIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, getService: () => current });
for (const channel of ['conversation', 'get-social-commands', 'retry-social', 'get-conversation-details', 'open-friend']) assert.equal(typeof handlers.get(`collaboration:${channel}`), 'function', channel);
const call = (channel, payload) => handlers.get(`collaboration:${channel}`)(null, payload);
assert.equal((await call('friend', { action: 'request', lilyId: 'Exact-ID' })).state, 'failed', 'permanent result retains identity and honest state');
assert.deepEqual(calls[0], { action: 'request', lilyId: 'exact-id' });
const create = { action: 'create', scopeType: 'organization', organizationId: 'org', kind: 'channel', visibility: 'private', title: 'Scope', memberUserIds: ['b', 'a'] };
assert.equal((await call('conversation', create)).conversationId, 'c');
assert.deepEqual(calls.at(-1).memberUserIds, ['a', 'b']);
for (const invalid of [{ ...create, role: 'owner' }, { ...create, deviceId: 'forged' }, { ...create, accessToken: 'SECRET' },
  { ...create, kind: 'direct' }, { ...create, visibility: 'public' }, { action: 'create', scopeType: 'personal', kind: 'direct', memberUserIds: ['a'] },
  { action: 'member', conversationId: 'c', targetUserId: 'x', operation: 'role', role: 'owner' },
  { action: 'member', conversationId: 'c', targetUserId: 'x', operation: 'remove', title: 'ignored' }]) {
  assert.equal((await call('conversation', invalid)).code, 'COLLABORATION_INVALID_INPUT');
}
for (const [name, payload] of [['get-social-commands', undefined], ['get-conversation-details', { conversationId: 'c' }], ['open-friend', { peerUserId: 'u' }]]) {
  assert.doesNotMatch(JSON.stringify(await call(name, payload)), /SECRET|token|email|key/);
}
assert.equal((await call('retry-social', { clientCommandId: 'stable', input: create })).code, 'COLLABORATION_INVALID_INPUT', 'retry cannot alter durable input');
let resolve;
current.conversation = () => new Promise((r) => { resolve = r; });
const late = call('conversation', create);
current = { ok: true };
resolve({ ok: true, state: 'completed', conversationId: 'old-account-private' });
assert.equal((await late).ok, false, 'IPC also fences account replacement during callback');
const preload = fs.readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8');
for (const method of ['conversation', 'getSocialCommands', 'retrySocial', 'getConversationDetails', 'openFriend']) assert.match(preload, new RegExp(`${method}:`));
console.log('collaboration social IPC allowlists passed');
