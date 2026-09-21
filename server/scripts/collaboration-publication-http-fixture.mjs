import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {TaskGit}=require('../../src/main/collaboration/task-git');
const {createSharedGitTransport}=require('../../src/main/collaboration/task-git-transport');
const {createSharedHeadSync}=require('../../src/main/collaboration/shared-head-sync');
const ok=value=>{assert.equal(value?.ok,true,JSON.stringify(value));return value;};

/** Actual signed API, encrypted object transfer and independent Git import.
 * Caller ran the original selected Node checks through the real TaskCore. */
export async function verifyPublicationHttp({owner,helper,task,conversationId,pool,dropAck,uploaded}){
  if(process.platform!=='darwin'){
    console.log('Shared publication signed HTTP/PG: NOT RUN; actual pinned-test validation requires the macOS sandbox.');return;
  }
  const journal=owner.records.list(conversationId).find(row=>row.kind==='shared-publication'&&row.state==='published');
  assert.ok(journal?.candidate&&journal.validation);
  const candidate=journal.candidate;
  assert.ok(journal.remoteReceipt,'automatic native publication must be acknowledged');
  const attempt=owner.records.list(conversationId).find(row=>row.kind==='remote-publication'&&row.receipt?.publicationId===journal.remoteReceipt.publicationId);
  assert.equal(attempt?.state,'confirmed');
  const outbox=owner.records.get(journal.outboxId);assert.equal(outbox.state,'sent');assert.deepEqual(outbox.receipt,journal.remoteReceipt);
  const input=attempt.request,sealed={objectId:attempt.objectId},receipt=journal.remoteReceipt;
  const scope={deviceId:owner.deviceId,workspaceId:task.sharedWorkspaceId,taskId:task.id,deliveryId:task.currentDeliveryId};
  const {evidenceHash}=journal.validation;
  const replay=await owner.client.publishIntegration(input);
  assert.equal(replay.headCommit,candidate.commit);assert.equal(replay.revision,receipt.revision);
  await assert.rejects(helper.client.publishIntegration({...input,deviceId:helper.deviceId,clientCommandId:'publication-assignee'}),{code:'COLLAB_TASK_ACCESS_DENIED'});
  assert.equal((await pool.query('SELECT count(*)::int n FROM collaboration_shared_publications WHERE workspace_id=$1',[task.sharedWorkspaceId])).rows[0].n,1);
  const object=(await pool.query('SELECT * FROM stored_objects WHERE id=$1',[sealed.objectId])).rows[0];
  assert.equal(object.shared_workspace_id,task.sharedWorkspaceId);assert.equal(object.task_id,null);assert.equal(object.bound_message_id,null);assert.equal(object.state,'bound');
  assert.ok(uploaded.get(object.object_key)?.bytes,'published object uses the actual verified encrypted provider transfer');
  await assert.rejects(helper.client.getIntegrationPublication({deviceId:helper.deviceId,workspaceId:task.sharedWorkspaceId}),{code:'COLLAB_TASK_ACCESS_DENIED'});
  await assert.rejects(helper.client.objects.downloadTicket({deviceId:helper.deviceId,clientCommandId:'assignee-shared-ticket',objectId:sealed.objectId}),{code:'COLLAB_OBJECT_UNAVAILABLE'});
  const download=ok(await owner.transfers.sharedFiles.download({conversationId,workspaceId:task.sharedWorkspaceId,publicationId:receipt.publicationId}));
  assert.equal(download.publication.validation.evidenceHash,evidenceHash);
  const receivingGit=new TaskGit({rootPath:path.join(owner.root,'independent-shared-receiver'),gitOptions:{autoInstall:false}});
  const imported=await createSharedGitTransport(receivingGit).importBundle({packagePath:download.packagePath,descriptor:download.publication.git});
  assert.equal(imported.commit,candidate.commit);
  const {git}=await receivingGit.ensure();
  assert.equal(await git(['rev-parse',`${imported.commit}^{tree}`]),candidate.tree);
  assert.equal(await git(['rev-list','--parents','-n','1',imported.commit]),`${candidate.commit} ${candidate.head} ${candidate.delivery}`);
  assert.equal(await git(['show',`${imported.commit}:work.txt`]),'reviewed');
  const inputBinding=owner.records.get(journal.intentId).input;
  const canonical=await owner.workflow.acquireIntegrationHead(inputBinding);
  assert.equal(canonical.head.commit,candidate.commit);assert.equal(canonical.head.remoteRevision,receipt.revision);
  const reconstructed=new TaskGit({rootPath:path.join(owner.root,'canonical-shared-receiver'),gitOptions:{autoInstall:false}});
  const sync=createSharedHeadSync({taskGit:reconstructed,client:owner.client,sharedFiles:owner.transfers.sharedFiles,accountId:'a',deviceId:owner.deviceId,
    assertActive(){},authorize:()=>owner.workflow.authorizeIntegration(inputBinding)});
  const remoteHead=await sync.acquire({input:inputBinding,baseline:canonical.baseline});
  assert.equal(remoteHead.commit,candidate.commit);assert.equal(remoteHead.publicationId,receipt.publicationId);
  assert.equal(fs.readFileSync(path.join(owner.source,'work.txt'),'utf8'),'baseline','remote publication leaves private W unchanged');
  assert.equal((await owner.client.getIntegrationTarget(scope)).lease,null);
  await pool.query("UPDATE stored_objects SET state='revoked' WHERE id=$1",[sealed.objectId]);
  assert.equal((await owner.transfers.sharedFiles.download({conversationId,workspaceId:task.sharedWorkspaceId,publicationId:receipt.publicationId})).ok,false,'a downloaded cache cannot bypass publication retirement');
  await assert.rejects(owner.client.publishIntegration(input),{code:'COLLAB_INTEGRATION_PACKAGE_UNAVAILABLE'});
  await pool.query("UPDATE stored_objects SET state='bound' WHERE id=$1",[sealed.objectId]);
  console.log('Shared publication signed HTTP/PG: actual validated candidate, encrypted upload, fenced CAS, lost ACK recovery, independent Git download/import, owner ACL and retired cache passed.');
}
