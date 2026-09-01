import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring');
const { createCollaborationService } = require('../src/main/collaboration/service');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-actions-'));
const store = new CollaborationStore({ accountId: 'alice', dbPath: path.join(dir, 'db'), keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys'), safeStorage: {
  isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
} }) });
store.replaceProjectionFromBootstrap({ watermark: 1, conversations: [{ id: 'personal-canonical', scopeType: 'personal', kind: 'direct' }, { id: 'team-canonical', scopeType: 'organization', organizationId: 'org', kind: 'direct' }],
  members: ['personal-canonical', 'team-canonical'].flatMap((conversation_id) => ['alice', 'bob'].map((user_id) => ({ conversation_id, user_id, role: 'member', status: 'active', joined_seq: 0 }))),
  relationships: [{ user_low_id: 'alice', user_high_id: 'bob', status: 'active' }] });
let role = 'owner', visibility = 'private', error = null;
const service = createCollaborationService({ openStore: () => ({ ok: true, store }), deviceId: 'd', realtimeEnabled: false, client: {
  getConversationProjection: async ({ conversationId }) => { if (error) throw error; return { conversation: { id: conversationId, scopeType: 'personal', kind: 'group', title: 'Group' },
    members: [{ conversationId, userId: 'alice', role, status: 'active', joinedSeq: 0 }], profiles: [] }; },
} });
try {
  assert.equal(typeof service.openFriend, 'function', 'friend chat resolves existing canonical direct');
  assert.equal(service.openFriend({ peerUserId: 'bob' }).conversationId, 'personal-canonical', 'never guesses Team or display-name identity');
  assert.equal(service.openFriend({ peerUserId: 'missing' }).ok, false);
  assert.equal((await service.getConversationDetails({ conversationId: 'group' })).canManage, true);
  role = 'member';
  assert.equal((await service.getConversationDetails({ conversationId: 'group' })).canManage, false, 'member cannot see management controls');
  error = Object.assign(new Error('Denied'), { code: 'COLLAB_CONVERSATION_UNAVAILABLE' });
  assert.equal((await service.getConversationDetails({ conversationId: 'group' })).ok, false, 'denial never falls back to stale management role');
  store.db.run("UPDATE directory_contacts SET own_blocked = 1 WHERE account_id = 'alice' AND user_id = 'bob'");
  assert.equal(service.openFriend({ peerUserId: 'bob' }).ok, false);
  assert.equal(service.list().conversations.some((c) => c.id.endsWith('canonical')), false, 'own block hides personal and Team direct entry, not shared channels');
  console.log('collaboration social directory actions passed');
} finally { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
