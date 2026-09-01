import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring');
const { createSocialCommands } = require('../src/main/collaboration/social-commands');
const { removeConversationRows } = require('../src/main/collaboration/access-revocation');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-command-revocation-'));
const store = new CollaborationStore({ accountId: 'alice', dbPath: path.join(dir, 'cache.db'), keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys'), safeStorage: {
  isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
} }) });
let sent = 0;
try {
  store.db.run("INSERT INTO directory_teams(account_id,id,scope_id,name,role) VALUES ('alice','org','team:org','Org','admin')");
  const team = createSocialCommands({ store, deviceId: 'device', assertActive() {},
    client: { submitConversation: async () => { sent++; return { ok: true, result: { conversationId: 'new-private-channel' } }; } },
    onConfirmed: async () => store.revokeScope({ scopeId: 'team:org' }),
  });
  const result = await team.submit('conversation', { action: 'create', scopeType: 'organization', organizationId: 'org', kind: 'channel', visibility: 'private' });
  assert.equal(result.code, 'COLLAB_ACCESS_REVOKED', 'bootstrap revocation after commit must fence final command result');
  assert.equal(result.ok, false);
  assert.equal(result.conversationId, undefined, 'revoked navigation target never reaches the renderer');
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM social_commands").n, 0, 'revocation still deletes scoped journal before destroying keys');
  const personal = createSocialCommands({ store, deviceId: 'device', assertActive() {},
    client: { submitConversation: async () => { sent++; return { ok: true, result: { conversationId: 'removed-group' } }; } },
    onConfirmed: async () => store.db.transaction(() => removeConversationRows(store, 'removed-group', 'personal'))(),
  });
  const removed = await personal.submit('conversation', { action: 'create', scopeType: 'personal', kind: 'group', clientCommandId: 'group-command' });
  assert.equal(removed.code, 'COLLAB_ACCESS_REVOKED', 'conversation revocation applies even when personal scope and command survive');
  assert.equal(removed.conversationId, undefined);
  assert.equal((await personal.retry({ clientCommandId: 'group-command' })).code, 'COLLAB_ACCESS_REVOKED', 'cached completed receipt cannot restore revoked navigation');
  assert.equal(sent, 2, 'revocation cannot turn committed commands into replays');
  assert.equal(store.db.get("SELECT state FROM social_commands WHERE id='group-command'").state, 'completed', 'commit evidence is retained without a false failure transition');
  console.log('collaboration social post-confirmation revocation passed');
} finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
