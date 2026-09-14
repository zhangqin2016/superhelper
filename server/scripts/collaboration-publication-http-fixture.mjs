import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {TaskGit}=require('../../src/main/collaboration/task-git');
const {createSharedGitTransport}=require('../../src/main/collaboration/task-git-transport');
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
  const taskGit=new TaskGit({rootPath:path.dirname(candidate.repository),gitOptions:{autoInstall:false}});
  const exported=await createSharedGitTransport(taskGit).exportBundle({revision:candidate,destination:path.join(owner.root,'shared-publication.bundle')});
  const transfer=ok(await owner.transfers.taskFiles.prepareUpload({conversationId,inputPath:exported.packagePath,originalName:'shared.bundle',expectedPlaintextSha256:exported.descriptor.sha256}));
  const sealed=ok(await owner.transfers.taskFiles.upload(transfer.id));
  const scope={deviceId:owner.deviceId,workspaceId:task.sharedWorkspaceId,taskId:task.id,deliveryId:task.currentDeliveryId};
  const head=await owner.client.getIntegrationTarget(scope);
  const claim={...scope,clientCommandId:'publication-http-claim',expectedHead:head.headCommit,expectedRevision:head.revision};
  const lease=await owner.client.claimIntegration(claim);
  const {commit,policyId,evidenceHash}=journal.validation;
  const input={...claim,clientCommandId:'publication-http',leaseId:lease.lease.id,generation:lease.generation,publicationId:'publication-http',objectId:sealed.objectId,
    baselineCommit:candidate.baseline,deliveryCommit:candidate.delivery,tree:candidate.tree,git:exported.descriptor,validation:{commit,policyId,evidenceHash}};
  await assert.rejects(owner.client.publishIntegration({...input,clientCommandId:'publication-stale-generation',generation:lease.generation-1}),{code:'COLLAB_INTEGRATION_FENCED'});
  await assert.rejects(helper.client.publishIntegration({...input,deviceId:helper.deviceId,clientCommandId:'publication-assignee'}),{code:'COLLAB_TASK_ACCESS_DENIED'});
  dropAck('/api/collaboration/v1/tasks/integration/publish');
  await assert.rejects(owner.client.publishIntegration(input),'committed publication ACK deliberately lost');
  const receipt=await owner.client.publishIntegration(input);
  assert.equal(receipt.headCommit,candidate.commit);assert.equal(receipt.revision,head.revision+1);
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
  assert.equal(fs.readFileSync(path.join(owner.source,'work.txt'),'utf8'),'baseline','remote publication leaves private W unchanged');
  assert.equal((await owner.client.getIntegrationTarget(scope)).lease,null);
  await pool.query("UPDATE stored_objects SET state='revoked' WHERE id=$1",[sealed.objectId]);
  assert.equal((await owner.transfers.sharedFiles.download({conversationId,workspaceId:task.sharedWorkspaceId,publicationId:receipt.publicationId})).ok,false,'a downloaded cache cannot bypass publication retirement');
  await assert.rejects(owner.client.publishIntegration(input),{code:'COLLAB_INTEGRATION_PACKAGE_UNAVAILABLE'});
  await pool.query("UPDATE stored_objects SET state='bound' WHERE id=$1",[sealed.objectId]);
  console.log('Shared publication signed HTTP/PG: actual validated candidate, encrypted upload, fenced CAS, lost ACK recovery, independent Git download/import, owner ACL and retired cache passed.');
}
