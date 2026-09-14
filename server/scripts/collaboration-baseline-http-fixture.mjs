import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {TaskGit}=require('../../src/main/collaboration/task-git');
const {createTaskGitTransport}=require('../../src/main/collaboration/task-git-transport');
const {createSharedHeadSync}=require('../../src/main/collaboration/shared-head-sync');
const ok=value=>{assert.equal(value?.ok,true,JSON.stringify(value));return value;};
export async function verifyBaselineHttp({owner,helper,conversationId,pool,dropAck}){
  const root=path.join(owner.root,'baseline-http');fs.mkdirSync(root);
  const workspaceId=`baseline_${randomUUID()}`,source=new TaskGit({rootPath:path.join(root,'source'),gitOptions:{autoInstall:false}});
  const transport=createTaskGitTransport(source);
  const snapshot=(name,text)=>{const snapshotRoot=path.join(root,name);fs.mkdirSync(snapshotRoot);fs.writeFileSync(path.join(snapshotRoot,'work.txt'),text);
    return {snapshotRoot,manifest:[{path:'work.txt',sizeBytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')}]};};
  async function upload(actor,revision,name){
    const pack=await transport.exportBundle({revision,prerequisites:revision.parents||[],destination:path.join(root,name)});
    const transfer=ok(await actor.transfers.taskFiles.prepareUpload({conversationId,inputPath:pack.packagePath,originalName:'baseline.bundle',expectedPlaintextSha256:pack.descriptor.sha256}));
    return {objectId:ok(await actor.transfers.taskFiles.upload(transfer.id)).objectId,git:pack.descriptor};
  }
  async function makeTask(name,text){
    const base=snapshot(`${name}-base`,text),baseline=await source.captureBaseline({taskId:name,...base});
    const pack=await upload(owner,baseline,`${name}-input.bundle`);
    const command=async(actor,fields)=>(ok(await actor.client.submitTask({deviceId:actor.deviceId,clientCommandId:randomUUID(),...fields}))).result;
    const {taskId}=await command(owner,{action:'create',conversationId,sharedWorkspaceId:workspaceId,assigneeUserId:'b',inputSnapshotId:pack.objectId,inputGit:pack.git,title:name,objective:'Cross-task baseline',acceptanceCriteria:'Exact source'});
    await command(helper,{action:'accept',taskId,expectedRevision:1});
    const delivery=await source.captureContribution({baseline,baseManifest:base.manifest,materializedPaths:['work.txt'],deliveryId:`${name}-delivery`,...snapshot(`${name}-changed`,`${text} changed`)});
    const change=await upload(helper,{...delivery,parents:[baseline.commit]},`${name}-delivery.bundle`);
    await command(helper,{action:'submit',taskId,expectedRevision:2,deliveryId:change.objectId,deliveryGit:change.git});
    return {taskId,deliveryId:change.objectId,baseline,objectId:pack.objectId,descriptor:pack.git,packagePath:path.join(root,`${name}-input.bundle`)};
  }
  const original=await makeTask('baseline-original','original shared H');
  const scope={deviceId:owner.deviceId,workspaceId,taskId:original.taskId,deliveryId:original.deliveryId};
  const claim={...scope,clientCommandId:randomUUID(),expectedHead:original.baseline.commit,expectedRevision:0};
  dropAck('/api/collaboration/v1/tasks/integration/claim');await assert.rejects(owner.client.claimIntegration(claim));
  const held=await owner.client.claimIntegration(claim);
  assert.equal((await pool.query('SELECT count(*)::int n FROM collaboration_shared_baselines WHERE workspace_id=$1',[workspaceId])).rows[0].n,1,'lost first claim ACK creates one durable baseline');
  await owner.client.releaseIntegration({...claim,clientCommandId:randomUUID(),leaseId:held.lease.id,generation:held.generation});
  const current=await makeTask('baseline-current','new private B');assert.notEqual(original.baseline.commit,current.baseline.commit);
  ok(await owner.client.submitTask({deviceId:owner.deviceId,clientCommandId:randomUUID(),action:'cancel',taskId:original.taskId,expectedRevision:3}));
  assert.equal((await owner.transfers.taskFiles.download({conversationId,taskId:original.taskId,objectId:original.objectId})).ok,false,'ordinary task authority ends when its source is cancelled');
  const input={conversationId,workspaceId,taskId:current.taskId,deliveryId:current.deliveryId};
  await pool.query('DELETE FROM collaboration_shared_baselines WHERE workspace_id=$1',[workspaceId]);
  assert.equal((await owner.client.getIntegrationTarget({deviceId:owner.deviceId,...input})).baselineReady,false);
  const resolve={deviceId:owner.deviceId,clientCommandId:randomUUID(),workspaceId,taskId:current.taskId,deliveryId:current.deliveryId,expectedHead:original.baseline.commit,expectedRevision:0};
  await assert.rejects(helper.client.resolveIntegrationBaseline({...resolve,deviceId:helper.deviceId,clientCommandId:randomUUID()}),{code:'COLLAB_TASK_ACCESS_DENIED'});
  dropAck('/api/collaboration/v1/tasks/integration/baseline/resolve');await assert.rejects(owner.client.resolveIntegrationBaseline(resolve));
  assert.equal((await owner.client.resolveIntegrationBaseline(resolve)).ready,true,'signed recovery of a legacy H survives its committed response being lost');
  assert.equal((await owner.client.getIntegrationTarget({deviceId:owner.deviceId,...input})).generation,held.generation,'baseline restoration never consumes a lease generation');
  assert.equal((await owner.client.getIntegrationTarget({deviceId:owner.deviceId,...input})).headCommit,original.baseline.commit);
  const receiver=new TaskGit({rootPath:path.join(root,'receiver'),gitOptions:{autoInstall:false}});
  const localB=await createTaskGitTransport(receiver).importBundle({packagePath:current.packagePath,descriptor:current.descriptor});
  assert.equal(await receiver.hasRevision(original.baseline),false);
  const sync=createSharedHeadSync({taskGit:receiver,client:owner.client,sharedFiles:owner.transfers.sharedFiles,accountId:'a',deviceId:owner.deviceId,
    assertActive(){},authorize:async()=>{const task=await owner.client.getTask({deviceId:owner.deviceId,taskId:current.taskId});return task.state==='review'&&task.sharedWorkspaceId===workspaceId;}});
  const head=await sync.acquire({input,baseline:localB}),{git}=await receiver.ensure();
  assert.equal(head.commit,original.baseline.commit);assert.equal(head.remoteRevision,0);
  assert.equal(await git(['show',`${head.commit}:work.txt`]),'original shared H');assert.equal(await git(['rev-list','--parents','-n','1',head.commit]),head.commit);
  assert.equal(await git(['show',`${localB.commit}:work.txt`]),'new private B');
  await assert.rejects(helper.client.getIntegrationBaseline({deviceId:helper.deviceId,workspaceId}),{code:'COLLAB_TASK_ACCESS_DENIED'});
  await assert.rejects(helper.client.objects.downloadTicket({deviceId:helper.deviceId,clientCommandId:randomUUID(),objectId:original.objectId}),{code:'COLLAB_OBJECT_UNAVAILABLE'});
  await pool.query("UPDATE stored_objects SET state='revoked' WHERE id=$1",[original.objectId]);
  assert.equal((await owner.transfers.sharedFiles.downloadBaseline({conversationId,workspaceId})).ok,false,'cached initial H still requires a fresh available source object');
  await assert.rejects(sync.acquire({input,baseline:localB}),{code:'COLLAB_INTEGRATION_PACKAGE_UNAVAILABLE'});
  await pool.query("UPDATE stored_objects SET state='bound' WHERE id=$1",[original.objectId]);
  console.log('Initial H signed HTTP/PG: different task B, lost claim ACK, cancelled source, encrypted owner download into independent Git, private B preservation and revoked cache passed.');
}
