import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring');
const { createTaskRecords } = require('../src/main/collaboration/task-records');
const { removeConversationRows, removeScopeRows, prepareBootstrapAccess } = require('../src/main/collaboration/access-revocation');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-task-records-'));
const keyring = new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys'), safeStorage: {
  isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString(),
} });
const options = { accountId: 'owner', dbPath: path.join(dir, 'cache.db'), keyring };
let store, stopped = false, records;
function open() {
  stopped = false; store = new CollaborationStore(options);
  records = createTaskRecords({ store, assertActive: () => {
    if (stopped) throw Object.assign(new Error('Stopped'), { code: 'COLLABORATION_STOPPED' });
  } });
}
function conversation(id, scope = 'personal', account = 'owner') {
  store.db.run('INSERT OR REPLACE INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES (?,?,?,?,0)', account, id, scope, 'direct');
}
const revoked = error => error.code === 'COLLAB_ACCESS_REVOKED';
open();
try {
  conversation('chat'); conversation('other'); conversation('team-chat', 'team:alpha');
  const value = { conversationId: 'chat', privatePath: '/private/secret-workspace', draft: { title: 'Private budget' }, journal: ['prepared'] };
  assert.deepEqual(records.put('draft:z', { ...value, id: 'forged' }), { ...value, id: 'draft:z' });
  records.put('draft:a', { conversationId: 'chat', journal: ['committed'] });
  records.put('other', { conversationId: 'other', title: 'Other conversation' });
  assert.deepEqual(records.list('chat').map(row => row.id), ['draft:a', 'draft:z'], 'stable order and conversation isolation');
  assert.equal(records.get('missing'), null);
  const raw = JSON.stringify(store.db.all('SELECT * FROM task_workspace_records'));
  assert.doesNotMatch(raw, /secret-workspace|Private budget|prepared|committed/);
  store.close(); open();
  assert.deepEqual(records.get('draft:z'), { ...value, id: 'draft:z' }, 'local paths, drafts and journals survive SQLite reopen');
  assert.throws(() => records.put('draft:z', { conversationId: 'other' }), /binding/i);
  records.put('draft:z', { ...value, journal: ['applied'] });
  assert.deepEqual(records.get('draft:z').journal, ['applied']);
  assert.equal(store.db.get('SELECT COUNT(*) AS n FROM task_workspace_records WHERE id = ?', 'draft:z').n, 1);
  assert.throws(() => records.put('bad', {}));
  assert.throws(() => records.put('bad', { conversationId: 'absent' }), revoked);
  assert.throws(() => records.list('absent'), revoked);

  conversation('chat', 'personal', 'different');
  const otherStore = new CollaborationStore({ ...options, accountId: 'different' });
  try {
    const isolated = createTaskRecords({ store: otherStore, assertActive() {} });
    assert.equal(isolated.get('draft:z'), null, 'another account cannot discover the record');
    assert.deepEqual(isolated.list('chat'), []);
    isolated.put('draft:z', { conversationId: 'chat', title: 'Different account' });
    assert.equal(records.get('draft:z').draft.title, 'Private budget');
  } finally { otherStore.close(); }
  store.accountId = 'different';
  for (const call of [() => records.get('draft:z'), () => records.list('chat'), () => records.put('draft:z', value)]) {
    assert.throws(call, error => error.code === 'COLLAB_ACCOUNT_CHANGED');
  }
  store.accountId = 'owner';
  stopped = true;
  for (const call of [() => records.get('missing'), () => records.list('chat'), () => records.put('new', value)]) {
    assert.throws(call, error => error.code === 'COLLABORATION_STOPPED');
  }
  stopped = false;

  records.put('team', { conversationId: 'team-chat', path: '/private/team' });
  store.db.run("INSERT INTO revoked_scopes(account_id,scope_id,key_delete_pending) VALUES ('owner','team:alpha',0)");
  assert.throws(() => records.get('team'), revoked, 'a scope tombstone fences reads even before cleanup');
  assert.throws(() => records.list('team-chat'), revoked);
  assert.throws(() => records.put('team', { conversationId: 'team-chat' }), revoked);
  store.db.run("DELETE FROM revoked_scopes WHERE account_id = 'owner' AND scope_id = 'team:alpha'");
  store.db.run("UPDATE conversations SET scope_id = 'team:beta' WHERE account_id = 'owner' AND id = 'team-chat'");
  assert.throws(() => records.get('team'), /binding/i, 'scope changes cannot decrypt through a new authority');
  assert.throws(() => records.list('team-chat'), /binding/i);
  assert.throws(() => records.put('team', { conversationId: 'team-chat' }), /binding/i);
  store.db.run("UPDATE conversations SET scope_id = 'team:alpha' WHERE account_id = 'owner' AND id = 'team-chat'");
  store.db.transaction(() => removeConversationRows(store, 'chat', 'personal'))();
  assert.equal(records.get('draft:z'), null);
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM task_workspace_records WHERE account_id = 'owner' AND conversation_id = 'chat'").n, 0);
  conversation('chat'); // A stale row alone cannot clear an authorization tombstone.
  assert.throws(() => records.put('draft:z', value), revoked);
  assert.throws(() => records.list('chat'), revoked);

  store.db.run("DELETE FROM conversations WHERE account_id = 'owner' AND id = 'team-chat'");
  store.db.transaction(() => removeScopeRows(store, 'team:alpha'))();
  assert.equal(records.get('team'), null, 'scope retirement includes orphaned workspace records');
  assert.ok(store.db.get("SELECT 1 FROM revoked_conversations WHERE account_id = 'owner' AND conversation_id = 'team-chat'"));
  conversation('bootstrap-team', 'team:gamma'); records.put('bootstrap', { conversationId: 'bootstrap-team', path: '/private/bootstrap' });
  store.db.run("DELETE FROM conversations WHERE account_id = 'owner' AND id = 'bootstrap-team'");
  store.db.transaction(() => prepareBootstrapAccess(store, [{ id: 'other' }], [], () => 'personal'))();
  assert.equal(records.get('bootstrap'), null, 'bootstrap discovers revoked scopes from orphan records');
  conversation('orphan'); records.put('orphan', { conversationId: 'orphan' });
  store.db.run("DELETE FROM conversations WHERE account_id = 'owner' AND id = 'orphan'");
  store.db.transaction(() => prepareBootstrapAccess(store, [{ id: 'other' }], undefined, () => 'personal'))();
  assert.equal(records.get('orphan'), null, 'bootstrap removes orphan records from absent personal conversations');
  assert.equal(store.db.get("SELECT COUNT(*) AS n FROM task_workspace_records WHERE account_id = 'different'").n, 1, 'revocation never deletes another account records');
  console.log('remote task records: encrypted SQLite restart, account/scope binding, stable reads and revocation cleanup passed');
} finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
