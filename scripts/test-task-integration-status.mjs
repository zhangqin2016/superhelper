import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createTaskRecords}=require('../src/main/collaboration/task-records');
const {createIntegrationIntents}=require('../src/main/collaboration/integration-intents');
const {createTaskWorkflow}=require('../src/main/collaboration/task-workflow');
const {taskWorkflowCommand,taskWorkflowResult}=require('../src/main/collaboration/task-workflow-view');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'integration-status-'));
const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
const store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring});
try{
 store.replaceProjectionFromBootstrap({conversations:[{id:'chat',kind:'direct'}]});
 const records=createTaskRecords({store,assertActive(){}}),intents=createIntegrationIntents({store,assertActive(){}});
 let task={id:'task',conversationId:'chat',requesterUserId:'owner',assigneeUserId:'helper',sharedWorkspaceId:'shared',state:'review',currentDeliveryId:'delivery',inputGit:{commit:'a'.repeat(40)},deliveries:[{id:'delivery',git:{commit:'b'.repeat(40)}}]};
 const input={conversationId:'chat',workspaceId:'shared',taskId:'task',deliveryId:'delivery',targetId:createHash('sha256').update(root).digest('hex'),chain:'shared',sessionId:'session',projectId:'project',baselineCommit:'a'.repeat(40),deliveryCommit:'b'.repeat(40)};
 const intent=intents.enqueue(input);
 records.put('task:task',{kind:'task',conversationId:'chat',taskId:'task',sharedWorkspaceId:'shared',sourceRoot:root,sourceProjectId:'project',sourceSessionId:'session',gitBaseline:{commit:input.baselineCommit}});
 const workflow=createTaskWorkflow({store,assertActive(){},tasks:{get:async()=>({ok:true,task})},client:{},transfers:{},rootPath:path.join(root,'managed'),taskGitProtocol:1,
   resolveSourceSession:({projectId,sessionId})=>({projectId,sessionId,rootPath:root})});
 const command={operation:'integrationStatus',conversationId:'chat',taskId:'task'},retry={operation:'retryIntegration',conversationId:'chat',taskId:'task',deliveryId:'delivery'};
 assert.ok(taskWorkflowCommand(retry),'retry is a closed identity-only IPC command');assert.equal(taskWorkflowCommand({...retry,rootPath:root}),null);
 let status=await workflow.run(command);assert.equal(status.integration.stage,'queued');
 store.db.run("UPDATE task_integration_work SET state='waiting',attempts=3,code='COLLAB_NETWORK_UNAVAILABLE'");
 status=await workflow.run(command);assert.equal(status.integration.stage,'failed');assert.equal(status.integration.canRetry,true);
 const safe=taskWorkflowResult({...status,integration:{...status.integration,intentId:intent.id,rootPath:root,code:'PRIVATE'}});
 assert.deepEqual(safe.integration,{stage:'failed',deliveryId:'delivery',canRetry:true});
 assert.deepEqual(taskWorkflowResult({ok:true,cards:[{id:'card',integration:{...status.integration,intentId:intent.id,rootPath:root}}]}).cards[0].integration,safe.integration,'cards use the same closed status projection');
 const baselineId=`remote-baseline:${createHash('sha256').update(JSON.stringify(intent.id)).digest('hex')}`;
 records.put(baselineId,{kind:'remote-baseline-resolution',conversationId:'chat',intentId:intent.id,state:'unavailable',headCommit:'a'.repeat(40),request:null,nextCursor:null});
 assert.equal((await workflow.run({...retry,deliveryId:'stale'})).ok,false,'stale delivery cannot reset current work');
 assert.equal(records.get(baselineId).state,'unavailable');
 assert.equal((await workflow.run(retry)).ok,true);assert.equal((await workflow.run(retry)).ok,true,'repeated click reuses the queued intent');
 assert.equal(records.get(baselineId).state,'pending','an authorized explicit retry can rescan after a missing source is restored');
 assert.equal(intents.list('chat').length,1);assert.equal(store.db.get('SELECT attempts FROM task_integration_work').attempts,0);
 const lease=intents.claim(intent.id,{workerId:'worker'});store.db.run("UPDATE task_integration_work SET state='running'");
 assert.equal((await workflow.run(retry)).code,'COLLAB_TASK_BUSY');intents.release(lease);
 store.db.run("UPDATE task_integration_work SET state='waiting',code='COLLAB_INTEGRATION_VALIDATION_REQUIRED'");
 status=await workflow.run(command);assert.equal(status.integration.stage,'validation_required');assert.equal(status.integration.canRetry,false,'missing validator has no misleading retry action');
 assert.equal((await workflow.run(retry)).ok,false);
 task={...task,state:'changes_requested'};store.db.run("UPDATE task_integration_work SET state='waiting',code='COLLAB_NETWORK_UNAVAILABLE'");
 assert.equal((await workflow.run(retry)).ok,false,'fresh withdrawn review fences retry');
 task={...task,state:'review'};
 // Unresolved model questions surface as a decision stage; the requester's answer is stored as evidence and re-admits the same intent.
 store.db.run("UPDATE task_integration_work SET state='waiting',code='COLLAB_INTEGRATION_DECISION_REQUIRED'");
 records.put('publication-journal',{kind:'shared-publication',conversationId:'chat',intentId:intent.id,state:'conflicts',candidate:{state:'conflicts',repair:{policy:'model-repair-v1',questions:[{path:'budget.txt',question:'Keep 1.2M or accept 1.8M?'},{path:'../secret',question:''}]}}});
 status=await workflow.run(command);assert.equal(status.integration.stage,'decision_required');assert.equal(status.integration.canRetry,true);
 assert.deepEqual(status.integration.questions,[{path:'budget.txt',question:'Keep 1.2M or accept 1.8M?'}],'only well-formed questions cross the closed projection');
 assert.deepEqual(taskWorkflowResult({ok:true,integration:{...status.integration,questions:[{path:'budget.txt',question:'q',evidence:'private'}]}}).integration.questions,[{path:'budget.txt',question:'q'}]);
 const answer={operation:'answerIntegration',conversationId:'chat',taskId:'task',deliveryId:'delivery',answers:[{path:'budget.txt',answer:'Accept 1.8M'}]};
 assert.ok(taskWorkflowCommand(answer));assert.equal(taskWorkflowCommand({...answer,answers:[{path:'budget.txt',answer:'   '}]}),null);assert.equal(taskWorkflowCommand({...answer,answers:[{path:'budget.txt',answer:'x',rootPath:root}]}),null);
 assert.equal(taskWorkflowCommand({...answer,answers:[]}),null);
 assert.equal((await workflow.run({...answer,answers:[{path:'other.txt',answer:'x'}]})).code,'COLLAB_TASK_INVALID','answers must address an open question');
 const answered=await workflow.run(answer);assert.equal(answered.ok,true);assert.equal(answered.integration.stage,'queued');
 const stored=records.get(`integration-answers:${createHash('sha256').update(JSON.stringify(intent.id)).digest('hex')}`);
 assert.equal(stored.kind,'integration-answers');assert.deepEqual(stored.answers.map(a=>[a.path,a.question,a.answer]),[['budget.txt','Keep 1.2M or accept 1.8M?','Accept 1.8M']]);
 assert.equal(store.db.get('SELECT state FROM task_integration_work').state,'pending','an answer re-admits the durable work item');
 assert.doesNotMatch(JSON.stringify(store.db.all('SELECT payload_envelope_json FROM task_workspace_records')),/Accept 1.8M|Keep 1.2M/,'answers are encrypted at rest');
 store.db.run("UPDATE task_integration_work SET code='COLLAB_INTEGRATION_CONFLICT',state='waiting'");
 status=await workflow.run(command);assert.equal(status.integration.stage,'conflict');assert.equal(status.integration.canRetry,true,'a conflict can be retried once a model is configured');
 store.db.run("UPDATE task_integration_work SET code=NULL,state='pending'");
 const finalLease=intents.claim(intent.id,{workerId:'worker'});intents.complete(finalLease);
 assert.equal((await workflow.run(command)).integration.stage,'publication_pending','completed local Git work must not claim remote sync');
 records.put('outbox',{kind:'publication-outbox',conversationId:'chat',intentId:intent.id,state:'sent'});
 assert.equal((await workflow.run(command)).integration.stage,'published');
 const local={kind:'local-materialization',conversationId:'chat',intentId:intent.id,taskId:'task',deliveryId:'delivery',
  binding:{accountId:'owner',workspaceId:'shared',targetId:input.targetId,projectId:'project',sessionId:'session'},
  state:'ready',token:'token',fingerprint:'fingerprint',validation:{state:'passed',evidenceHash:'e'.repeat(64)}};
 records.put('local',local);store.db.run("UPDATE task_integration_work SET code='COLLAB_LOCAL_APPLICATION_PENDING'");
 assert.equal((await workflow.run(command)).integration.localStage,'waiting','shared publication does not imply local application');
 records.put('local',{...local,validation:{state:'failed'}});
 assert.equal((await workflow.run(command)).integration.localStage,'validation_failed');
 records.put('local',{...local,state:'applied'});
 assert.equal((await workflow.run(command)).integration.localStage,'validation_required','an applied label requires its local receipt');
 const revision={ref:'shared',commit:'c'.repeat(40),remoteRevision:1};
 records.put('local',{...local,state:'applied',applicationId:'application',sharedRevision:revision,
  receipt:{applicationId:'application',token:local.token,fingerprint:local.fingerprint,validationHash:local.validation.evidenceHash,sharedRevision:revision}});
 const applied=(await workflow.run(command)).integration;assert.equal(applied.localStage,'applied');
 const appliedRecord=records.get('local');
 records.put('local',{...appliedRecord,state:'undone'});
 assert.equal((await workflow.run(command)).integration.localStage,undefined,'an undone label requires its inverse linkage');
 records.put('local',{...appliedRecord,state:'undone',undoApplicationId:'undo-attempt'});
 assert.equal((await workflow.run(command)).integration.localStage,'undone','undone contribution is projected on the published shared state');
 assert.equal(taskWorkflowResult({ok:true,integration:{stage:'published',deliveryId:'delivery',canRetry:false,localStage:'undone'}}).integration.localStage,'undone');
 records.put('local',appliedRecord);
 assert.equal(taskWorkflowResult({ok:true,integration:{...applied,localStage:'private-path'}}).integration.localStage,undefined,'unknown local states cannot cross IPC');
 const reopened=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring});
 try{
  const persisted=createTaskRecords({store:reopened,assertActive(){}}).list('chat');
  const work=new Map(reopened.db.all('SELECT * FROM task_integration_work').map(row=>[row.intent_id,row]));
  assert.equal(require('../src/main/collaboration/integration-status').taskIntegration(task,persisted,work).status.localStage,'applied','task status survives an independent SQLite reopen');
 }finally{reopened.close();}
 assert.equal((await workflow.run(retry)).ok,false,'completed work cannot be queued again');
 console.log('integration status/retry: closed projections, same intent, stale delivery/running/withdrawn fences and no-validator wait passed');
}finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
