import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CollaborationStore } = require('../src/main/collaboration/collaboration-store');
const { LocalCollaborationKeyring } = require('../src/main/collaboration/local-keyring');
const { createTaskCommands } = require('../src/main/collaboration/task-commands');
const { taskView, taskCommand } = require('../src/main/collaboration/task-view');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-task-desktop-'));
const options = { accountId: 'owner', dbPath: path.join(dir, 'cache.db'), keyring: new LocalCollaborationKeyring({ filePath: path.join(dir, 'keys'), safeStorage: {
  isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString(),
} }) };
const task = { id:'task1', conversationId:'chat', requesterUserId:'owner', assigneeUserId:'helper', inputSnapshotId:'input1',
  title:'Private budget', objective:'Check totals', acceptanceCriteria:'No differences', state:'review', revision:3,
  currentDeliveryId:'delivery1', acceptedDeliveryId:null, deliveries:[{id:'delivery1',number:1,submittedAt:1}],createdAt:0,updatedAt:1 };
const command = {conversationId:'chat',taskId:'task1',action:'request_changes',expectedRevision:3,deliveryId:'delivery1',reason:'Secret revision notes'};
let mode='unknown', calls=[], store, stopped=false, pending;
const client={getTask:async()=>task,listTasks:async()=>[task],submitTask:async input=>{
  calls.push(input);
  if(mode==='hold') await new Promise(r=>pending=r);
  if(mode==='unknown') throw Object.assign(new Error('timeout'),{code:'COLLAB_RESPONSE_UNKNOWN'});
  if(mode==='conflict') throw Object.assign(new Error('changed'),{code:'COLLAB_TASK_REVISION_CONFLICT'});
  return {ok:true,result:{taskId: mode==='malformed'?'different':input.taskId,revision:input.expectedRevision+1,state:'changes_requested'}};
}};
function open(deviceId='device') {
  stopped=false; store=new CollaborationStore(options);
  store.db.run("INSERT OR IGNORE INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES ('owner','chat','personal','direct',0)");
  return createTaskCommands({store,client,deviceId,assertActive:()=>{if(stopped)throw Object.assign(new Error('Stopped'),{code:'COLLABORATION_STOPPED'});}});
}
function close(){stopped=true;store.close();}
let tasks=open();
try {
  assert.equal(taskCommand({...command,actorUserId:'helper'}),null,'closed vocabulary rejects forged authority');
  assert.equal(taskCommand({...command,reason:''}),null,'changes require a reason');
  assert.equal(taskCommand({...command,expectedRevision:'3'}),null);
  assert.equal(taskView({...task,token:'secret',path:'/private'}).token,undefined);
  assert.equal(taskView({...task,state:'completed'}),null,'unknown states never become completion');
  assert.equal((await tasks.list({conversationId:'chat'})).tasks[0].title,task.title);
  assert.equal((await tasks.get({conversationId:'chat',taskId:'different'})).ok,false,'a get must bind the requested task identity');
  const beforeForged=calls.length;
  assert.equal((await tasks.submit({...command,taskId:'different'})).ok,false,'task scope must be resolved on the server before sending');
  assert.equal(calls.length,beforeForged);
  const first=await tasks.submit(command);
  assert.equal(first.state,'confirming');
  assert.ok(first.clientCommandId);
  assert.equal(calls[0].conversationId,undefined,'local scope is not sent as an extra server command field');
  assert.doesNotMatch(JSON.stringify(store.db.all('SELECT * FROM task_commands')),/Secret revision notes/);
  close();tasks=open();
  assert.equal(tasks.pending({conversationId:'chat'}).commands[0].clientCommandId,first.clientCommandId);
  mode='conflict';
  assert.equal((await tasks.retry({clientCommandId:first.clientCommandId})).state,'confirming','later rejection cannot disprove prior uncertain commit');
  mode='success';
  assert.equal((await tasks.retry({clientCommandId:first.clientCommandId})).state,'completed');
  assert.equal(calls.at(-1).clientCommandId,first.clientCommandId);
  const count=calls.length;
  await tasks.retry({clientCommandId:first.clientCommandId});assert.equal(calls.length,count);
  mode='conflict';assert.equal((await tasks.submit({...command,reason:'new'})).state,'failed');
  mode='malformed';const malformed=await tasks.submit({...command,reason:'other'});assert.equal(malformed.state,'confirming');
  close();tasks=open('other-device');
  const before=calls.length;assert.equal((await tasks.retry({clientCommandId:malformed.clientCommandId})).code,'COLLAB_DEVICE_CHANGED');assert.equal(calls.length,before);
  close();tasks=open();mode='success';await tasks.retry({clientCommandId:malformed.clientCommandId});mode='hold';
  const late=tasks.submit({...command,reason:'late'});await new Promise(r=>setImmediate(r));
  store.db.transaction(()=>require('../src/main/collaboration/access-revocation').removeConversationRows(store,'chat','personal'))();
  pending();assert.equal((await late).ok,false,'revocation fences late completion and does not recreate encrypted rows');
  assert.equal(store.db.all('SELECT * FROM task_commands').length,0);
  assert.equal((await tasks.list({conversationId:'chat'})).ok,false);
  console.log('remote task desktop: strict views, encrypted SQLite restart, same-key retry, conflicts, device and revocation passed');
} finally {close();fs.rmSync(dir,{recursive:true,force:true});}
