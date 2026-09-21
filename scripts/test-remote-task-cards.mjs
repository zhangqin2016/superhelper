import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createTaskRecords}=require('../src/main/collaboration/task-records');
const {createTaskCards}=require('../src/main/collaboration/task-cards');
const {createTask,transitionTask}=require('../server/src/services/collaboration/task-contract.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-cards-'));
let store,records,cards;
function open(){
 const keyring=new LocalCollaborationKeyring({filePath:path.join(dir,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
 store=new CollaborationStore({accountId:'owner',dbPath:path.join(dir,'cache.db'),keyring});
 store.db.run("INSERT OR IGNORE INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES ('owner','chat','personal','direct',0)");
 records=createTaskRecords({store,assertActive(){}});cards=createTaskCards({store,assertActive(){}});
}
try{
 open();records.put('draft',{kind:'draft',conversationId:'chat',name:'Budget',state:'preparing',createdAt:10});
 assert.deepEqual(cards.list('chat').map(c=>[c.id,c.state,c.taskId]),[['draft','preparing',null]]);
 const task=createTask({id:'task',conversationId:'chat',assigneeUserId:'helper',inputSnapshotId:'object',title:'Budget review',objective:'Check totals',acceptanceCriteria:'Verified'},{actorUserId:'owner',authorizedParticipantIds:['owner','helper'],now:20});
 records.put('draft',{...records.get('draft'),state:'confirming',objectId:'object',input:{title:task.title,objective:task.objective,acceptanceCriteria:task.acceptanceCriteria,assigneeUserId:'helper'}});
 cards.remember(task);
 assert.equal(cards.list('chat').length,1,'server task discovered before ACK must use pending anchor');
 assert.equal(cards.list('chat')[0].id,'draft');
 const pending=records.get('draft');
 for (const change of [{objectId:'different-object'}, {sharedWorkspaceId:'different-workspace'},
   {input:{...pending.input,objective:'Different request'}}, {input:{...pending.input,assigneeUserId:'other'}}]) {
   records.put('draft',{...pending,...change});
   assert.equal(cards.list('chat').length,2,'unrelated intents cannot absorb authoritative cards');
 }
 records.put('draft',pending);
 records.put('draft',{...records.get('draft'),taskId:'task',state:'completed',input:{title:task.title}});
 const confirmed=cards.list('chat');assert.equal(confirmed.length,1,'acknowledgement cannot append a duplicate card');assert.equal(confirmed[0].id,'draft');assert.equal(confirmed[0].createdAt,10,'card stays at original local position');
 const active=transitionTask(task,{action:'accept',expectedRevision:1},{actorUserId:'helper',authorizedParticipantIds:['owner','helper'],now:30});
 cards.remember(active);assert.equal(cards.remember(task).revision,2,'late network replies cannot regress task state');
 assert.throws(()=>cards.remember({...active,title:'Contradictory'}),{code:'COLLAB_TASK_REVISION_CONFLICT'});
 assert.throws(()=>cards.remember({...task,id:'foreign',requesterUserId:'stranger'}),{code:'COLLAB_TASK_ACCESS_DENIED'});
 store.close();store=null;open();
 const restored=cards.list('chat');assert.equal(restored.length,1);assert.equal(restored[0].state,'active');assert.equal(restored[0].revision,2);
 records.put('draft',{...records.get('draft'),deviceId:'device',sourceProjectId:'project',sourceSessionId:'origin'});
 const session={projectId:'project',sessionId:'origin',deviceId:'device'};
 assert.equal(cards.forSession(session)[0].id,'draft','origin sees its persistent intent anchor');
 assert.equal(cards.forSession({...session,deviceId:'other'}).length,0,'binding belongs to this device');
 assert.equal(cards.forSession({...session,projectId:'other'}).length,0);
 assert.equal(cards.forSession({...session,sessionId:'other'}).length,0);
 const shared={...active,id:'shared-task',sharedWorkspaceId:'workspace'};
 cards.remember(shared);
 records.put('workspace-binding',{kind:'workspace-binding',conversationId:'chat',deviceId:'device',projectId:'project',sessionId:'receiver',sharedWorkspaceId:'workspace'});
 assert.deepEqual(cards.forSession({...session,sessionId:'receiver'}).map(c=>c.taskId),['shared-task'],'saved receiving workspace projects incoming tasks');
 store.close();store=null;open();
 assert.equal(cards.forSession(session)[0].id,'draft','origin card survives SQLite reopen');
 assert.equal(cards.forSession({...session,sessionId:'receiver'})[0].taskId,'shared-task','receiving binding survives SQLite reopen');
 assert.equal(JSON.stringify(store.db.all('SELECT * FROM task_workspace_records')).includes('Check totals'),false,'task content is encrypted');
 store.db.run("INSERT INTO revoked_conversations(account_id,conversation_id,scope_id) VALUES ('owner','chat','personal')");
 assert.throws(()=>cards.list('chat'),{code:'COLLAB_ACCESS_REVOKED'});
 assert.deepEqual(cards.forSession(session),[],'revoked conversation is removed from the local session');
 console.log('task cards: real SQLite pending anchor/ACK dedupe, monotonic state, encrypted reopen and participant/revocation guards passed');
}finally{store?.close();fs.rmSync(dir,{recursive:true,force:true});}
