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
      resolveWorkspaceBinding:input=>({projectId:input.projectId,sessionId:'fixture-session',rootPath:source})});
    const item={client,deviceId,store,source,tasks,transfers,records:createTaskRecords({store,assertActive}),run:command=>workflow.run({conversationId,...command}),
      close(){transfers.stop();client.stop();store.close();}};
    clients.push(item);return item;
  }
  try {
    let owner=open('a'),helper=open('b');
    fs.writeFileSync(path.join(owner.source,'unchanged.bin'),randomBytes(2*1024**2));
    fs.writeFileSync(path.join(owner.source,'work.txt'),'baseline');fs.writeFileSync(path.join(owner.source,'remove.txt'),'remove');
    const draft=ok(await owner.run({operation:'prepare'})).draft;
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
