import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {CollaborationStore}=require('../../src/main/collaboration/collaboration-store');
const {createTransferRuntime}=require('../../src/main/collaboration/transfer-runtime');
const {createTaskCommands}=require('../../src/main/collaboration/task-commands');
const {createTaskWorkflow}=require('../../src/main/collaboration/task-workflow');
const {createTaskRecords}=require('../../src/main/collaboration/task-records');
const {createIntegrationDiscovery}=require('../../src/main/collaboration/integration-discovery');
const {createCollaborationService}=require('../../src/main/collaboration/service');
const ok=value=>{assert.equal(value?.ok,true,JSON.stringify(value));return value;};

/** Full domain path: desktop workflow/encryption -> device-signed Fastify
 * routes -> real PostgreSQL/object verification. External provider and native
 * directory selection are fixtures; no physical-device/TLS acceptance claim. */
export async function verifyTaskGitServiceHttp({desktop,directory,fetchImpl,conversationId,pool,dropAck,uploaded}){
  const clients=[];
  function open(userId){
    const account=desktop(userId),{client,deviceId}=account;
    const root=path.join(directory,`git-workflow-${userId}`);fs.mkdirSync(root,{recursive:true});
    const source=path.join(root,'source');fs.mkdirSync(source,{recursive:true});
    const store=new CollaborationStore({dbPath:path.join(root,'store.db'),accountId:userId,keyring:account.keyring});
    if(!store.listConversations().length)store.replaceProjectionFromBootstrap({conversations:[{id:conversationId,scopeId:'team:org',kind:'channel'}]});
    const assertActive=()=>{},tasks=createTaskCommands({store,client,deviceId,assertActive});
    const transfers=createTransferRuntime({store,client,deviceId,assertActive,rootPath:path.join(root,'collaboration-transfer'),policy:{enabled:true,tasks:true,workspaceShares:true},fetchImpl});
    const workflow=createTaskWorkflow({store,client,deviceId,tasks,transfers,assertActive,rootPath:path.join(root,'managed'),taskGitProtocol:1,sharedWorkspaceProtocol:1,
      chooseDirectory:async()=>({canceled:false,filePaths:[source]}),
      resolveProjectDirectory:()=>source,resolveSourceSession:input=>({...input,rootPath:source}),
      resolveWorkspaceBinding:input=>({projectId:input.projectId,sessionId:'fixture-session',rootPath:source})});
    const item={client,deviceId,store,source,root,tasks,transfers,workflow,records:createTaskRecords({store,assertActive}),run:command=>workflow.run({conversationId,...command}),
      close(){transfers.stop();client.stop();store.close();}};
    clients.push(item);return item;
  }
  try {
    let owner=open('a'),helper=open('b');
    fs.writeFileSync(path.join(owner.source,'unchanged.bin'),randomBytes(2*1024**2));
    fs.writeFileSync(path.join(owner.source,'work.txt'),'baseline');fs.writeFileSync(path.join(owner.source,'remove.txt'),'remove');
    fs.writeFileSync(path.join(owner.source,'rule.test.cjs'),"require('node:test').test('reviewed contribution',()=>require('node:assert/strict').equal(require('node:fs').readFileSync(require('node:path').join(__dirname,'work.txt'),'utf8'),'reviewed'));");
    const draft=ok(await owner.run({operation:'prepare',projectId:'source-project',sessionId:'source-session'})).draft;
    const send={operation:'send',draftId:draft.id,assigneeUserId:'b',title:'Git domain integration',objective:'Revise synthetic files',acceptanceCriteria:'Exact result and recoverable replay'};
    dropAck('/api/collaboration/v1/tasks');assert.equal(ok(await owner.run(send)).state,'confirming');
    owner.close();owner=open('a');const sent=ok(await owner.run(send)),taskId=sent.taskId;
    assert.equal(sent.state,'completed');
    let task=await owner.client.getTask({deviceId:owner.deviceId,taskId});assert.ok(task.inputGit);assert.ok(task.sharedWorkspaceId);
    assert.equal((await pool.query('select count(*)::int n from collaboration_tasks where id=$1',[taskId])).rows[0].n,1);
    const objects=await pool.query('select id,state,task_id,object_key from stored_objects where task_id=$1',[taskId]);
    assert.equal(objects.rows.length,1);assert.equal(objects.rows[0].state,'bound');
    assert.ok(uploaded.get(objects.rows[0].object_key)?.bytes,'real verified ciphertext is bound by the actual package broker');
    ok(await helper.tasks.submit({conversationId,taskId,action:'accept',expectedRevision:task.revision}));
    ok(await helper.run({operation:'bind',taskId,projectId:'fixture-project'}));
    ok(await helper.run({operation:'receive',taskId}));
    const local=helper.records.get(`task:${taskId}`),working=local.workRoot;
    assert.equal(local.gitBaseline.commit,task.inputGit.commit);assert.equal(fs.readFileSync(path.join(working,'work.txt'),'utf8'),'baseline');
    fs.writeFileSync(path.join(working,'work.txt'),'reviewed');fs.unlinkSync(path.join(working,'remove.txt'));fs.writeFileSync(path.join(working,'added.txt'),'added');
    const delivery=ok(await helper.run({operation:'prepareDelivery',taskId})).draft;
    const submit={operation:'submitDelivery',taskId,draftId:delivery.id};
    dropAck('/api/collaboration/v1/tasks');assert.equal(ok(await helper.run(submit)).state,'confirming');
    fs.writeFileSync(path.join(working,'work.txt'),'after frozen submission');
    helper.close();helper=open('b');assert.equal(ok(await helper.run(submit)).state,'completed');
    task=await owner.client.getTask({deviceId:owner.deviceId,taskId});assert.equal(task.deliveries.length,1);
    const delivered=task.deliveries[0];assert.deepEqual(delivered.git.prerequisites,[task.inputGit.commit]);
    assert.ok(delivered.git.sizeBytes<task.inputGit.sizeBytes/100);
    assert.deepEqual((await owner.client.missingTaskGitObjects({deviceId:owner.deviceId,taskId,deliveryId:delivered.id,haveCommits:[task.inputGit.commit]})).objects,[{objectId:delivered.id,descriptor:delivered.git}]);
    const resolveSourceSession=input=>({...input,rootPath:owner.source});
    createIntegrationDiscovery({store:owner.store,assertActive(){},resolveSourceSession}).observe(task);
    const makeHost=()=>require('./collaboration-native-turn-fixture.cjs')({root:owner.root,source:owner.source,accountId:'a',execute:(request,execution)=>service.runIntegration(request,execution)});
    let host=makeHost(),foreground=host.orchestrator._state('source-session');foreground.phase='streaming';foreground.turnId='foreground';
    const service=createCollaborationService({openStore:()=>({ok:true,store:owner.store}),client:owner.client,deviceId:owner.deviceId,realtimeEnabled:false,
      policy:{enabled:true,tasks:true,workspaceShares:true,taskGitProtocol:1,sharedWorkspaceProtocol:1},
      transferOptions:{rootPath:path.join(owner.root,'collaboration-transfer'),fetchImpl},taskOptions:{rootPath:path.join(owner.root,'managed'),resolveSourceSession,
        chooseValidationChecks:async()=>({filePaths:[path.join(owner.source,'rule.test.cjs')]}),enqueueIntegrationTurn:request=>host.enqueue(request)}});
    assert.equal(service.ok,true);service.start();
    try{
      const deadline=Date.now()+15000;
      while(!foreground.queue.length && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(foreground.queue.length,1,'service startup admits the actual original-session background turn');
      assert.equal(foreground.turnId,'foreground');assert.equal(owner.records.list(conversationId).some(row=>row.kind==='shared-publication'),false,'busy foreground prevents premature integration work');
      const admissionBeforeRestart=owner.records.list(conversationId).find(row=>row.kind==='integration-admission');
      host.close();host=makeHost();foreground=host.orchestrator._state('source-session');
      const repeated=await host.enqueue(admissionBeforeRestart.request);assert.equal(repeated.duplicate,true);assert.equal(repeated.turnId,admissionBeforeRestart.turnId);
      assert.equal(foreground.queue.length,1,'actual SessionManager/MessageStore reopen restores one background operation');
      void host.orchestrator.startRecoveredTurns('source-session');
      while(owner.store.db.get('SELECT state FROM task_integration_work')?.state!=='waiting' && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(owner.store.db.get('SELECT code FROM task_integration_work')?.code,'COLLAB_INTEGRATION_VALIDATION_REQUIRED','real service startup acquires and prepares the signed encrypted delivery without UI');
      const journal=owner.records.list(conversationId).find(row=>row.kind==='shared-publication');assert.equal(journal.state,'validation_failed');
      const evidence=owner.records.list(conversationId).find(row=>row.kind==='candidate-validation'&&row.evidenceHash===journal.validationAttempt.evidenceHash);
      assert.equal(evidence.report.commit,journal.candidate.commit);assert.equal(evidence.report.state,'required');
      assert.equal(evidence.report.checks[0].status,'passed');assert.equal(evidence.report.checks.at(-1).status,'passed','signed service delivery is materialized and rechecked before recording evidence');
      assert.equal(journal.candidate.delivery,delivered.git.commit);assert.equal(fs.readFileSync(path.join(owner.source,'work.txt'),'utf8'),'baseline','background preparation leaves foreground/private files untouched');
      const admitted=owner.records.list(conversationId).find(row=>row.kind==='integration-admission');
      while(foreground.phase!=='idle' && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
      const turn=host.manager._store().getTurnInputByTurnId(admitted.turnId,'a');
      assert.equal(turn.terminalType,'turn.completed');assert.equal(turn.taskCore.sessionId,'source-session');assert.equal(turn.taskCore.projectId,'source-project');
      assert.equal(host.manager.getConversation('source-session').filter(message=>message.role==='user').length,0,'background integration never invents user instructions');
      const configured=ok(await service.taskWorkflow({operation:'configureIntegrationChecks',conversationId,taskId,deliveryId:delivered.id}));
      assert.equal(configured.integration.stage,'queued');assert.equal(configured.integration.checkCount,1);
      const checkedDeadline=Date.now()+15000;
      const executable=process.platform==='darwin',expectedWork=executable?'done':'waiting';
      while(owner.store.db.get('SELECT state FROM task_integration_work')?.state!==expectedWork && Date.now()<checkedDeadline)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(owner.store.db.get('SELECT state FROM task_integration_work')?.state,expectedWork,'selected checks execute or explicitly wait for a supported sandbox through the next real TaskCore turn');
      const published=owner.records.get(journal.id);assert.equal(published.state,executable?'published':'validation_failed');
      const checked=owner.records.list(conversationId).find(row=>row.kind==='candidate-validation'&&row.evidenceHash===(published.validation||published.validationAttempt).evidenceHash);
      assert.equal(checked.report.state,executable?'passed':'required');
      const execution=checked.report.checks.find(check=>check.id==='project-policy').execution;
      if(executable)assert.equal(execution.execution.summary.counts.tests,1);else assert.equal(execution.execution.code,'SANDBOX_UNAVAILABLE');
      assert.equal(execution.execution.state,executable?'passed':'required');
      assert.equal(execution.executionCopyUnchanged,true);assert.equal(fs.readFileSync(path.join(owner.source,'work.txt'),'utf8'),'baseline');
      const nextAdmission=owner.records.list(conversationId).find(row=>row.kind==='integration-admission');
      assert.notEqual(nextAdmission.turnId,admitted.turnId,'configuration wakes a fresh bounded attempt in the original session');
      while(foreground.phase!=='idle' && Date.now()<checkedDeadline)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(host.manager._store().getTurnInputByTurnId(nextAdmission.turnId,'a').terminalType,'turn.completed');
    }finally{service.stop();host.close();}
    owner.close();owner=open('a');
    ok(await owner.tasks.submit({conversationId,taskId,action:'approve',deliveryId:delivered.id,expectedRevision:task.revision}));
    const preview=ok(await owner.run({operation:'preview',taskId,deliveryId:delivered.id}));
    assert.deepEqual(preview.plan.entries.map(item=>item.operation).sort(),['add','delete','replace']);
    ok(await owner.run({operation:'apply',taskId,deliveryId:delivered.id,applicationId:preview.applicationId,expectedPlanHash:preview.planHash,confirmDeletions:true}));
    assert.equal(fs.readFileSync(path.join(owner.source,'work.txt'),'utf8'),'reviewed');assert.equal(fs.existsSync(path.join(owner.source,'remove.txt')),false);
    ok(await owner.run({operation:'rollback',taskId,applicationId:preview.applicationId}));assert.equal(fs.readFileSync(path.join(owner.source,'work.txt'),'utf8'),'baseline');
    const observer=desktop('outsider');clients.push({close:()=>observer.client.stop()});
    await assert.rejects(observer.client.missingTaskGitObjects({deviceId:observer.deviceId,taskId,haveCommits:[]}),{code:'COLLAB_TASK_ACCESS_DENIED'});
    // Simulate administrative object retirement, then exercise the actual
    // signed missing-query and download-ticket domain checks on cached bytes.
    await pool.query("update stored_objects set state='revoked' where id=$1",[task.inputSnapshotId]);
    await assert.rejects(owner.client.missingTaskGitObjects({deviceId:owner.deviceId,taskId,deliveryId:delivered.id,haveCommits:[task.inputGit.commit,delivered.git.commit]}),{code:'COLLAB_TASK_PACKAGE_UNAVAILABLE'});
    assert.equal((await helper.transfers.taskFiles.download({conversationId,taskId,objectId:task.inputSnapshotId})).ok,false);
    console.log('Git task signed HTTP/PG: real encrypted workflow/broker, shared identity, lost create/delivery ACK restart, incremental ancestry, apply/rollback, outsider denial and revoked cache passed (provider/native selection fixtures).');
  } finally {for(const item of clients)item.close();}
}
