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
 assert.equal(JSON.stringify(store.db.all('SELECT * FROM task_workspace_records')).includes('Check totals'),false,'task content is encrypted');
 store.db.run("INSERT INTO revoked_conversations(account_id,conversation_id,scope_id) VALUES ('owner','chat','personal')");
 assert.throws(()=>cards.list('chat'),{code:'COLLAB_ACCESS_REVOKED'});
 console.log('task cards: real SQLite pending anchor/ACK dedupe, monotonic state, encrypted reopen and participant/revocation guards passed');
}finally{store?.close();fs.rmSync(dir,{recursive:true,force:true});}
