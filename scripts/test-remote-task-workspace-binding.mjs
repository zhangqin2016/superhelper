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
const {taskWorkflowCommand,taskWorkflowResult}=require('../src/main/collaboration/task-workflow-view');
const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'workspace-binding-')));
let store, records, revoked=false, resolutions=0;
function open() {
  const keyring=new LocalCollaborationKeyring({filePath:path.join(temporary,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
  store=new CollaborationStore({accountId:'helper',dbPath:path.join(temporary,'cache.db'),keyring});
  store.db.run("INSERT OR IGNORE INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES ('helper','chat','personal','direct',0)");
  records=createTaskRecords({store,assertActive(){}});
  return createTaskWorkflow({store,assertActive(){},deviceId:'device',rootPath:path.join(temporary,'managed'),
    tasks:{get:async({taskId})=>revoked?{ok:false,code:'COLLAB_TASK_ACCESS_DENIED'}:{ok:true,task:{id:taskId,conversationId:'chat',state:'active',sharedWorkspaceId:'shared',requesterUserId:'owner',assigneeUserId:'helper'}}},
    resolveWorkspaceBinding(input){resolutions++;return {projectId:input.projectId,sessionId:input.sessionId||'session',rootPath:temporary};}});
}
const command={operation:'bind',conversationId:'chat',taskId:'task1',projectId:'project',sessionId:'session'};
try {
  assert.deepEqual(taskWorkflowCommand(command),command,'binding command carries IDs only');
  assert.equal(taskWorkflowCommand({...command,rootPath:temporary}),null);
  let workflow=open();
  const result=await workflow.run(command);assert.equal(result.ok,true);
  assert.equal(result.sessionId,'session');
  assert.equal(JSON.stringify(taskWorkflowResult(result)).includes(temporary),false);
  assert.equal(JSON.stringify(store.db.all('SELECT * FROM task_workspace_records')).includes(temporary),false);
  store.close();store=null;workflow=open();
  const next=await workflow.run({...command,taskId:'task2'});
  assert.equal(next.sessionId,result.sessionId,'another task after reopen binds to the same session');
  assert.equal(records.get('task:task2').workspaceBindingId,records.get('task:task1').workspaceBindingId);
  assert.equal((await workflow.run({...command,projectId:'other'})).code,'COLLAB_TASK_BINDING_CONFLICT','later task cannot silently move the workspace');
  revoked=true;const count=resolutions;
  assert.equal((await workflow.run(command)).ok,false);
  assert.equal(resolutions,count,'remote authority is checked before touching local sessions');
  console.log('workspace binding: encrypted SQLite reopen, cross-task reuse, immutable target, ACL and safe projection passed; session resolver fixture');
} finally {store?.close();fs.rmSync(temporary,{recursive:true,force:true});}
