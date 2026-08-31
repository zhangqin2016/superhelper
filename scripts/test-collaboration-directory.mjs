import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store.js');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring.js');
const { createCollaborationSyncEngine } = require('../src/main/collaboration/sync-engine.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-directory-'));
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys'), safeStorage: {
  isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
} });
const options = { dbPath: path.join(dir, 'cache.db'), accountId: 'alice', keyring };
let store = new CollaborationStore(options);
const snapshot = { directorySchemaVersion: 1, watermark: 4, conversations: [], profile: { userId: 'alice', lilyId: 'alice-id', displayName: 'Alice', email: 'private' },
  profiles: ['bob', 'carol', 'dan', 'teammate'].map((userId) => ({ userId, displayName: userId, phone: 'private' })),
  relationships: [{ user_low_id: 'alice', user_high_id: 'bob', status: 'active' }],
  friendRequests: [{ id: 'request-in', sender_user_id: 'carol', receiver_user_id: 'alice', status: 'pending' },
    { id: 'request-out', sender_user_id: 'alice', receiver_user_id: 'dan', status: 'pending' }],
  blocks: [{ blocker_user_id: 'alice', blocked_user_id: 'bob' }],
  teams: [{ id: 'org', name: 'Team', role: 'admin', status: 'active' }],
  teamMembers: [{ organization_id: 'org', user_id: 'alice', display_name: 'Alice', role: 'admin' },
    { organization_id: 'org', user_id: 'teammate', display_name: 'Teammate', role: 'member' }],
};
try {
  assert.equal(typeof store.getDirectory, 'function', 'store exposes the offline directory');
  store.replaceProjectionFromBootstrap(snapshot);
  const initial = store.getDirectory();
  assert.deepEqual(initial.contacts.map(({ userId, relationship, requestId, ownBlocked }) => ({ userId, relationship, requestId, ownBlocked })), [
    { userId: 'bob', relationship: 'friend', requestId: null, ownBlocked: true },
    { userId: 'carol', relationship: 'incoming', requestId: 'request-in', ownBlocked: false },
    { userId: 'dan', relationship: 'outgoing', requestId: 'request-out', ownBlocked: false },
  ]);
  assert.equal(initial.profile.userId, 'alice');
  assert.equal(initial.teams[0].scopeId, 'team:org');
  assert.deepEqual(initial.teams[0].members.map((m) => m.userId), ['alice', 'teammate']);
  assert.doesNotMatch(JSON.stringify(initial), /private|phone|email|token|path/);
  store.close(); store = new CollaborationStore(options);
  assert.deepEqual(store.getDirectory(), initial, 'same-account restart retains directory');
  store.replaceProjectionFromBootstrap({ watermark: 4, conversations: [], profile: snapshot.profile });
  assert.deepEqual(store.getDirectory(), initial, 'legacy server missing pending/block/team directory fields cannot erase the newer cached directory');
  store.replaceProjectionFromBootstrap({ watermark: 4, conversations: [], relationships: [
    ...snapshot.relationships, { user_low_id: 'alice', user_high_id: 'frank', status: 'active' },
  ] });
  assert.equal(store.getDirectory().contacts.find((p) => p.userId === 'frank').relationship, 'friend', 'legacy active friendships still project');
  store.replaceProjectionFromBootstrap({ watermark: 4, conversations: [], relationships: [] });
  assert.deepEqual(store.getDirectory(), { ...initial, contacts: initial.contacts.map((p) => p.userId === 'bob' ? { ...p, relationship: null } : p) },
    'explicit legacy friendship snapshot removes absent friends, retaining unknown requests, own blocks, profiles and Team directory');
  store.replaceProjectionFromBootstrap(snapshot);
  assert.throws(() => store.replaceProjectionFromBootstrap({ ...snapshot, blocks: undefined }), /directory.*invalid/i, 'v1 partial snapshot fails closed');
  assert.deepEqual(store.getDirectory(), initial);
  for (const partial of [{ teams: undefined }, { teamMembers: undefined }, { teams: {} }, { teamMembers: {} }]) {
    assert.throws(() => store.replaceProjectionFromBootstrap({ ...snapshot, watermark: 99, ...partial }), /(directory|bootstrap).*invalid/i,
      'v1 complete snapshot requires both Team arrays before changing directory or cursor');
    assert.deepEqual(store.getDirectory(), initial, 'invalid v1 Team arrays preserve the complete cached roster');
    assert.deepEqual(store.getSyncState(), { cursor: 4, watermark: 4 }, 'invalid v1 Team arrays cannot advance the ACK cursor');
  }
  const other = new CollaborationStore({ ...options, accountId: 'other' });
  try { assert.deepEqual(other.getDirectory(), { profile: null, contacts: [], teams: [] }); } finally { other.close(); }
  const engine = createCollaborationSyncEngine({ store });
  function event(type, actorUserId, peer, extras = {}) {
    const cursor = store.getSyncState().cursor + 1;
    return { cursor, id: `event-${cursor}`, type, actorUserId, payload: { participantUserIds: ['alice', peer], ...extras } };
  }
  function apply(row) { engine.applyPage({ fromCursor: row.cursor - 1, toCursor: row.cursor, events: [row] }); }
  apply(event('user.blocked', 'carol', 'carol', { status: 'blocked' }));
  assert.equal(store.getDirectory().contacts.find((p) => p.userId === 'carol').ownBlocked, false, 'peer block not leaked');
  apply(event('friend.accepted', 'alice', 'carol', { status: 'active', requestId: 'request-in' }));
  assert.equal(store.getDirectory().contacts.find((p) => p.userId === 'carol').relationship, 'friend');
  apply(event('friend.declined', 'dan', 'dan', { status: 'declined', requestId: 'request-out' }));
  assert.equal(store.getDirectory().contacts.some((p) => p.userId === 'dan'), false);
  apply(event('friend.removed', 'bob', 'bob', { status: 'removed' }));
  assert.equal(store.getDirectory().contacts.find((p) => p.userId === 'bob').relationship, null);
  apply(event('user.unblocked', 'alice', 'bob', { status: 'unblocked' }));
  assert.equal(store.getDirectory().contacts.some((p) => p.userId === 'bob'), false);
  apply(event('friend.requested', 'alice', 'eve', { status: 'pending', requestId: 'req-eve', profilesByUserId: { eve: { userId: 'eve', displayName: 'Eve' } } }));
  assert.equal(store.getDirectory().contacts.find((p) => p.userId === 'eve').relationship, 'outgoing');
  const before = store.getDirectory(), cursor = store.getSyncState().cursor;
  const malformed = event('friend.requested', 'alice', 'x', { status: 'pending', requestId: 'req-x', participantUserIds: ['alice', {}] });
  assert.throws(() => apply(malformed), /directory.*invalid/i);
  assert.equal(store.getSyncState().cursor, cursor);
  assert.deepEqual(store.getDirectory(), before, 'invalid event rolls back projections and cursor');
  for (const mutation of [{ friendRequests: {} }, { blocks: [{ blocker_user_id: 'bob', blocked_user_id: 'alice' }] },
    { teamMembers: [{ organization_id: 'foreign', user_id: 'intruder', role: 'member' }] },
    { relationships: [{ user_low_id: 'bob', user_high_id: 'carol', status: 'active' }] }]) {
    assert.throws(() => store.replaceProjectionFromBootstrap({ ...snapshot, ...mutation }), /directory.*invalid/i);
    assert.deepEqual(store.getDirectory(), before);
    assert.equal(store.getSyncState().cursor, cursor);
  }
  apply({ cursor: cursor + 1, id: 'revoke', type: 'scope.revoked', payload: { scopeType: 'organization', organizationId: 'org', userId: 'alice' } });
  assert.deepEqual(store.getDirectory().teams, [], 'Team revocation removes directory without needing a conversation');
  assert.equal(store.getProfile({ userId: 'teammate' }), null, 'Team-only cached public profiles are purged after revocation');
  assert.equal(store.getProfile({ userId: 'carol' }).userId, 'carol', 'personal friend profiles survive Team revocation');
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM directory_team_members WHERE account_id = ?', 'alice').n, 0);
  store.replaceProjectionFromBootstrap({ ...snapshot, teams: [], teamMembers: [] });
  assert.deepEqual(store.getDirectory().teams, []);
  console.log('collaboration directory passed');
} finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
