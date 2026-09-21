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
let store, records, revoked=false, resolutions=0, opened, cancelSelection=false, revokeDuringChoice=false;
function open() {
  const keyring=new LocalCollaborationKeyring({filePath:path.join(temporary,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
  store=new CollaborationStore({accountId:'helper',dbPath:path.join(temporary,'cache.db'),keyring});
  store.db.run("INSERT OR IGNORE INTO conversations(account_id,id,scope_id,kind,updated_at) VALUES ('helper','chat','personal','direct',0)");
  records=createTaskRecords({store,assertActive(){}});
  return createTaskWorkflow({store,assertActive(){},deviceId:'device',rootPath:path.join(temporary,'managed'),
    tasks:{get:async({taskId})=>revoked?{ok:false,code:'COLLAB_TASK_ACCESS_DENIED'}:{ok:true,task:{id:taskId,conversationId:'chat',state:'active',sharedWorkspaceId:taskId.startsWith('folder')?taskId:'shared',requesterUserId:'owner',assigneeUserId:'helper'}}},
    chooseDirectory:async()=>{if(revokeDuringChoice)revoked=true;return {canceled:cancelSelection,filePaths:[temporary]};},
    resolveWorkspaceBinding(input){resolutions++;return {projectId:input.projectId||'chosen',sessionId:input.sessionId||'session',rootPath:temporary};},
    listWorkspaceBindings(){return [{id:'project',name:'Existing',sessions:[{id:'session',title:'Conversation'}]}];},
    openWorkspace(input){opened=input;return {projectId:input.projectId,sessionId:'execution-session'};}});
}
const command={operation:'bind',conversationId:'chat',taskId:'task1',projectId:'project',sessionId:'session'};
try {
  assert.deepEqual(taskWorkflowCommand(command),command,'binding command carries IDs only');
  assert.equal(taskWorkflowCommand({...command,rootPath:temporary}),null);
  let workflow=open();
  const choices=await workflow.run({operation:'bindingOptions',conversationId:'chat',taskId:'task1'});
  assert.equal(choices.ok,true);assert.equal(choices.projects[0].id,'project');assert.equal(choices.binding,null);
  const result=await workflow.run(command);assert.equal(result.ok,true);
  assert.equal(result.sessionId,'session');
  assert.equal(JSON.stringify(taskWorkflowResult(result)).includes(temporary),false);
  assert.equal(JSON.stringify(store.db.all('SELECT * FROM task_workspace_records')).includes(temporary),false);
  store.close();store=null;workflow=open();
  const saved=await workflow.run({operation:'bindingOptions',conversationId:'chat',taskId:'task2'});
  assert.deepEqual(saved.binding,{projectId:'project',sessionId:'session'});
  const next=await workflow.run({...command,taskId:'task2'});
  assert.equal(next.sessionId,result.sessionId,'another task after reopen binds to the same session');
  assert.equal(records.get('task:task2').workspaceBindingId,records.get('task:task1').workspaceBindingId);
  const workRoot=path.join(temporary,'isolated');fs.mkdirSync(workRoot);
  records.put('task:task2',{...records.get('task:task2'),workRoot});
  const openedResult=await workflow.run({operation:'open',conversationId:'chat',taskId:'task2'});
  assert.equal(openedResult.ok,true);
  assert.equal(opened.projectId,'project','opening an isolated task cannot create another top-level workspace');
  assert.equal(opened.rootPath,workRoot,'the execution session receives task material, not unrelated private files');
  assert.equal((await workflow.run({...command,projectId:'other'})).code,'COLLAB_TASK_BINDING_CONFLICT','later task cannot silently move the workspace');
  const folder={operation:'bind',conversationId:'chat',taskId:'folder-task'};
  assert.equal((await workflow.run(folder)).projectId,'chosen','native folder grant can register a project');
  cancelSelection=true;
  assert.equal((await workflow.run({...folder,taskId:'folder-cancel'})).cancelled,true);
  cancelSelection=false;revokeDuringChoice=true;
  const beforeChoice=resolutions;
  assert.equal((await workflow.run({...folder,taskId:'folder-revoked'})).ok,false);
  assert.equal(resolutions,beforeChoice,'revocation while chooser is open prevents project registration');
  revoked=true;const count=resolutions;
  assert.equal((await workflow.run(command)).ok,false);
  assert.equal(resolutions,count,'remote authority is checked before touching local sessions');
  console.log('workspace binding: encrypted SQLite reopen, cross-task reuse, immutable target, ACL and safe projection passed; session resolver fixture');
} finally {store?.close();fs.rmSync(temporary,{recursive:true,force:true});}
