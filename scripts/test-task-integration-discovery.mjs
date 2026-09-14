import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createTaskRecords}=require('../src/main/collaboration/task-records');
const {createTaskCards}=require('../src/main/collaboration/task-cards');
const {createIntegrationIntents}=require('../src/main/collaboration/integration-intents');
const {createIntegrationDiscovery}=require('../src/main/collaboration/integration-discovery');
const {createTaskHydration,queueTaskHydration}=require('../src/main/collaboration/task-hydration');
const {createTaskHistory}=require('../src/main/collaboration/task-history');
const {createCollaborationService}=require('../src/main/collaboration/service');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'integration-discovery-'));
const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
const inputGit={version:1,format:'git-bundle-v2',ref:`refs/tasks/${'a'.repeat(64)}/baseline`,commit:'a'.repeat(40),prerequisites:[],sha256:'b'.repeat(64),sizeBytes:500};
let task={id:'task',conversationId:'chat',requesterUserId:'owner',assigneeUserId:'helper',inputSnapshotId:'input',sharedWorkspaceId:'shared',title:'Review',objective:'Revise',acceptanceCriteria:'Validated',state:'review',revision:3,createdAt:1,updatedAt:3,inputGit,
  deliveries:[{id:'delivery',number:1,submittedAt:3,git:{...inputGit,ref:`refs/tasks/${'a'.repeat(64)}/deliveries/${'c'.repeat(64)}`,commit:'b'.repeat(40),prerequisites:[inputGit.commit]}}],currentDeliveryId:'delivery',acceptedDeliveryId:null};
let store,now=1000,resolverCalls=0;
function open(){
  store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring,now:()=>now});
  const assertActive=()=>{},intents=createIntegrationIntents({store,assertActive,now:()=>now});
  const discovery=createIntegrationDiscovery({store,assertActive,resolveSourceSession:({projectId,sessionId})=>{resolverCalls++;return {projectId,sessionId,rootPath:root};}});
  const onTask=task=>discovery.observe(task);
  return {intents,records:createTaskRecords({store,assertActive}),discovery,hydration:createTaskHydration({store,assertActive,deviceId:'device',client:{getTask:async()=>task},onTask}),
    history:createTaskHistory({store,assertActive,deviceId:'device',protocol:1,client:{listTaskHistory:async()=>({tasks:[task],nextCursor:null})},onTask})};
}
try{
  let local=open();store.replaceProjectionFromBootstrap({conversations:[{id:'chat',kind:'direct'}]});
  queueTaskHydration(store,{type:'task.updated',payload:{taskId:'task',revision:3}});
  store.db.run('UPDATE task_hydration SET access_denied=1');await local.hydration.recover();
  assert.equal(createTaskCards({store,assertActive(){}}).list('chat').length,1,'missing local binding does not hide the received task card');
  assert.equal(createTaskCards({store,assertActive(){}}).list('chat')[0].integration.stage,'binding_required','visible card explains deferred original binding');
  assert.equal(store.db.get('SELECT state FROM task_hydration').state,'pending','unbound delivery remains durable for later discovery');
  assert.equal(resolverCalls,0,'discovery must not create an unbound source session');
  local.records.put('task:task',{kind:'task',conversationId:'chat',taskId:'task',sharedWorkspaceId:'shared',sourceRoot:root,sourceProjectId:'project',sourceSessionId:'original-session',gitBaseline:{commit:inputGit.commit}});
  store.close();now+=31000;local=open();await local.hydration.recover();
  const intents=local.intents.list('chat');assert.equal(intents.length,1);assert.equal(intents[0].input.sessionId,'original-session');assert.equal(intents[0].input.deliveryCommit,'b'.repeat(40));
  assert.equal(store.db.get('SELECT count(*) n FROM task_hydration').n,0);
  assert.equal(createTaskCards({store,assertActive(){}}).list('chat')[0].integration.stage,'queued','restored binding exposes durable queue state');
  assert.doesNotMatch(JSON.stringify(createTaskCards({store,assertActive(){}}).list('chat')),/inputGit|deliveryCommit|original-session/);
  queueTaskHydration(store,{type:'task.updated',payload:{taskId:'task',revision:3}});await local.hydration.recover();await local.history.recover();
  assert.equal(local.intents.list('chat').length,1,'replayed live events and history discovery deduplicate');
  task={...task,state:'changes_requested',revision:4,updatedAt:4};queueTaskHydration(store,{type:'task.updated',payload:{taskId:'task',revision:4}});await local.hydration.recover();
  assert.equal(local.intents.get(intents[0].id).state,'cancelled','superseded review intent cannot be executed after changes are requested');
  assert.equal(createTaskCards({store,assertActive(){}}).list('chat')[0].integration.stage,'cancelled');
  task={...task,state:'review',revision:5,updatedAt:5,currentDeliveryId:'delivery-2',deliveries:[...task.deliveries,{...task.deliveries[0],id:'delivery-2',number:2,submittedAt:5,git:{...task.deliveries[0].git,commit:'c'.repeat(40)}}]};
  now+=310000;await local.history.recover();assert.equal(local.intents.list('chat').filter(item=>item.state==='pending').length,1,'historical delivery also creates a durable intent without a live event');
  const latest=task;task={...task,state:'changes_requested',revision:4,updatedAt:4,currentDeliveryId:'delivery',deliveries:task.deliveries.slice(0,1)};
  now+=310000;await local.history.recover();assert.equal(local.intents.list('chat').filter(item=>item.state==='pending').length,1,'stale history cannot cancel a newer delivery intent');
  task=latest;await local.hydration.recover();
  task={...task,state:'changes_requested',revision:6,updatedAt:6};queueTaskHydration(store,{type:'task.updated',payload:{taskId:'task',revision:6}});
  const service=createCollaborationService({openStore:()=>({ok:true,store}),deviceId:'device',realtimeEnabled:false,
    policy:{enabled:true,tasks:true,workspaceShares:true,taskGitProtocol:1},taskOptions:{resolveSourceSession:({projectId,sessionId})=>({projectId,sessionId,rootPath:root})},
    client:{getTask:async()=>task,syncAndAcknowledge:async()=>({events:[]})}});
  assert.equal(service.ok,true);service.start();
  for(let i=0;i<100&&store.db.get('SELECT count(*) n FROM task_hydration').n;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(local.intents.list('chat').filter(item=>item.state==='pending').length,0,'service startup applies fresh event discovery without opening a task panel');
  service.stop();store=null;
  console.log('integration discovery: hydration/history, deferred original binding, SQLite reopen, private Git metadata, dedupe and withdrawn review cancellation passed');
}finally{store?.close();fs.rmSync(root,{recursive:true,force:true});}
