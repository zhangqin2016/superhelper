import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {CollaborationStore} = require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring} = require('../src/main/collaboration/local-keyring');
const {createTaskWorkflow} = require('../src/main/collaboration/task-workflow');
const {freezeTaskBundle, unpackTaskBundle} = require('../src/main/collaboration/task-bundle');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-preparation-')));
const source = path.join(temporary, 'source'); fs.mkdirSync(source);
fs.writeFileSync(path.join(source, 'budget.txt'), 'budget\n');
let store, changes = 0, entered, release;
const started = new Promise(resolve => { entered = resolve; });
function open(freeze = freezeTaskBundle) {
  const keyring = new LocalCollaborationKeyring({filePath:path.join(temporary, 'keys'), safeStorage:{
    isEncryptionAvailable:()=>true, encryptString:text=>Buffer.from(text), decryptString:bytes=>bytes.toString(),
  }});
  store = new CollaborationStore({accountId:'owner', dbPath:path.join(temporary, 'cache.db'), keyring});
  store.db.run("INSERT OR IGNORE INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES ('owner','chat','personal','direct',0)");
  return createTaskWorkflow({store, assertActive(){}, deviceId:'device', rootPath:path.join(temporary, 'managed'),
    chooseDirectory:async()=>({filePaths:[source]}), bundle:{freezeTaskBundle:freeze, unpackTaskBundle},
    onChange(){changes++;}, client:{submitTask(){assert.fail('unprepared material must never be sent');}}});
}
try {
  let workflow = open(async input => { entered(); await new Promise(resolve=>{release=resolve;}); throw new Error('disk unavailable'); });
  const preparing = workflow.run({operation:'prepare', conversationId:'chat'});
  await started;
  const pendingView = await workflow.run({operation:'drafts', conversationId:'chat'});
  assert.equal(pendingView.ok, true, 'pending state must remain readable during preparation');
  let drafts = pendingView.drafts;
  assert.equal(drafts.length, 1, 'a durable pending identity exists before reading the bundle');
  const id = drafts[0].id;
  assert.equal(drafts[0].state, 'preparing');
  assert.equal((await workflow.run({operation:'prepare', conversationId:'chat', draftId:id})).code, 'COLLAB_TASK_BUSY', 'resume cannot race a still active freeze');
  assert.ok(changes > 0, 'observers learn of preparation before the operation finishes');
  assert.equal((await workflow.run({operation:'send', conversationId:'chat', draftId:id, assigneeUserId:'helper', title:'Budget', objective:'Update', acceptanceCriteria:'Verified'})).code, 'COLLAB_TASK_NOT_PREPARED');
  const beforeReads = changes;
  await workflow.run({operation:'drafts', conversationId:'chat'});
  assert.equal(changes, beforeReads, 'read-only projection cannot create a refresh loop');
  release(); assert.equal((await preparing).ok, false);
  store.close(); store = null;
  workflow = open();
  drafts = (await workflow.run({operation:'drafts', conversationId:'chat'})).drafts;
  assert.equal(drafts[0].id, id);
  assert.equal(drafts[0].state, 'preparation_failed', 'failed preparation remains recoverable after SQLite reopen');
  const retried = await workflow.run({operation:'prepare', conversationId:'chat', draftId:id});
  assert.equal(retried.ok, true);
  assert.equal(retried.draft.id, id, 'retry preserves the same future conversation card anchor');
  assert.equal(retried.draft.state, 'prepared');
  assert.equal((await workflow.run({operation:'drafts', conversationId:'chat'})).drafts.length, 1);
  assert.equal((await workflow.run({operation:'prepare', conversationId:'other', draftId:id})).ok, false);
  assert.equal((await workflow.run({operation:'prepare', conversationId:'chat', draftId:id, projectId:'other'})).ok, false);
  console.log('task preparation: deferred I/O, durable failure/retry and SQLite reopen passed; no live transport');
} finally { store?.close(); fs.rmSync(temporary, {recursive:true, force:true}); }
