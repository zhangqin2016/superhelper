import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createTaskWorkflow}=require('../src/main/collaboration/task-workflow');
const {createTaskRecords}=require('../src/main/collaboration/task-records');
const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'workspace-identity-')));
const source=path.join(temporary,'source');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'budget.txt'),'budget');
let store, records, sent=[];
function open(protocol) {
  const keyring=new LocalCollaborationKeyring({filePath:path.join(temporary,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
  store=new CollaborationStore({accountId:'owner',dbPath:path.join(temporary,'cache.db'),keyring});
  for(const id of ['chat','other'])store.db.run("INSERT OR IGNORE INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES ('owner',?,'personal','direct',0)",id);
  records=createTaskRecords({store,assertActive(){}});
  return createTaskWorkflow({store,assertActive(){},deviceId:'device',sharedWorkspaceProtocol:protocol,rootPath:path.join(temporary,'managed'),resolveProjectDirectory:async()=>source,
    client:{async submitTask(input){sent.push(input);return {ok:true,result:{taskId:'task'+sent.length,state:'offered',revision:1}};}},
    transfers:{taskFiles:{prepareUpload:async()=>({ok:true,id:'transfer'}),upload:async()=>({ok:true,state:'verified',objectId:'object'})}}});
}
const prepare=(workflow,conversationId='chat')=>workflow.run({operation:'prepare',conversationId,projectId:'project'});
try {
  let workflow=open(1), first=await prepare(workflow);
  assert.equal(first.ok,true);
  const identity=records.get(first.draft.id).sharedWorkspaceId;
  assert.equal(typeof identity,'string','negotiated sharing persists an identity before sending');
  store.close();store=null;workflow=open(1);
  const second=await prepare(workflow);
  assert.equal(records.get(second.draft.id).sharedWorkspaceId,identity,'new task after reopen reuses the source workspace');
  const other=await prepare(workflow,'other');
  assert.notEqual(records.get(other.draft.id).sharedWorkspaceId,identity,'another ACL conversation gets an isolated identity');
  const command={operation:'send',conversationId:'chat',draftId:second.draft.id,assigneeUserId:'helper',title:'Budget',objective:'Review',acceptanceCriteria:'Verified'};
  assert.equal((await workflow.run(command)).ok,true);
  assert.equal(sent[0].sharedWorkspaceId,identity);
  assert.equal(records.get('task:task1').sharedWorkspaceId,identity,'task binding retains the accepted source identity');
  store.close();store=null;workflow=open(undefined);
  assert.equal((await workflow.run({...command,draftId:first.draft.id})).code,'COLLAB_TASK_PROTOCOL_UNAVAILABLE','downgrade cannot silently rewrite an existing intent');
  assert.equal(sent.length,1);
  const legacy=await prepare(workflow);
  assert.equal(records.get(legacy.draft.id).sharedWorkspaceId,undefined,'older service keeps the original create contract');
  await workflow.run({...command,draftId:legacy.draft.id});
  assert.equal(Object.hasOwn(sent[1],'sharedWorkspaceId'),false);
  assert.equal(JSON.stringify(store.db.all('SELECT * FROM task_workspace_records')).includes(source),false,'local directory is encrypted');
  console.log('workspace identity: real SQLite reopen, source reuse, conversation isolation, negotiated send and legacy omission passed');
} finally {store?.close();fs.rmSync(temporary,{recursive:true,force:true});}
