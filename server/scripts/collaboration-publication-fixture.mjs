import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createCollaborationTaskService} from '../src/services/collaboration/tasks.js';
import {createKyselyConversationRepository} from '../src/services/collaboration/conversation-repository.js';
import {createTaskPackageBroker} from '../src/services/collaboration/task-packages.js';
import {writeCollaborationEvent} from '../src/services/collaboration/event-writer.js';
export async function verifySharedPublications({service,pool,database,crypto,owner,helper,taskId,workspaceId,deliveryId}){
  const task=await service.get({account:owner,taskId}),baselineCommit=task.inputGit.commit,deliveryCommit=task.deliveries[0].git.commit;
  const scope={account:owner,workspaceId,taskId,deliveryId};
  await pool.query("UPDATE collaboration_integration_targets SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1",[workspaceId]);
  const head=await service.getIntegrationTarget(scope);
  const claim={...scope,expectedHead:head.headCommit,expectedRevision:head.revision,clientCommandId:'publication-claim'};
  const lease=await service.claimIntegration(claim);
  const seed=async id=>pool.query("INSERT INTO stored_objects(id,owner_user_id,conversation_id,scope_type,purpose,object_key,state,ciphertext_size,ciphertext_sha256,mime_type,original_name) VALUES($1,'owner','chat','personal','workspace',$1,'verified',1000,$2,'application/octet-stream','shared.bundle')",[id,'a'.repeat(64)]);
  await seed('published-object');await seed('competing-object');
  const git={version:1,format:'git-bundle-v2',ref:`refs/workspaces/${createHash('sha256').update(JSON.stringify(workspaceId)).digest('hex')}/candidates/${'f'.repeat(64)}`,commit:'f'.repeat(40),prerequisites:[],sha256:'a'.repeat(64),sizeBytes:500};
  const input={...claim,clientCommandId:'publish',leaseId:lease.lease.id,generation:lease.generation,publicationId:'publication',objectId:'published-object',baselineCommit,deliveryCommit,tree:'c'.repeat(40),git,validation:{commit:git.commit,policyId:'original-node',evidenceHash:'d'.repeat(64)}};
  assert.equal(typeof service.publishIntegration,'function','server must atomically publish a fenced candidate');
  await assert.rejects(service.publishIntegration({...input,generation:lease.generation+1}),{code:'COLLAB_INTEGRATION_FENCED'});
  await assert.rejects(service.publishIntegration({...input,baselineCommit:'0'.repeat(40)}),{code:'COLLAB_INTEGRATION_SOURCE_CHANGED'});
  await assert.rejects(service.publishIntegration({...input,git:{...git,prerequisites:[head.headCommit]}}),{code:'COLLAB_INTEGRATION_FULL_PACK_REQUIRED'});
  const broken=createCollaborationTaskService({repository:createKyselyConversationRepository(database),crypto,packages:createTaskPackageBroker(),integrationLeasesEnabled:true,
    commandOperations:{completeReceipt:async()=>{throw Error('receipt-failure');}}});
  await assert.rejects(broken.publishIntegration(input),/receipt-failure/);
  const expiresDuringCommit=createCollaborationTaskService({repository:createKyselyConversationRepository(database),crypto,packages:createTaskPackageBroker(),integrationLeasesEnabled:true,
    commandOperations:{writeEvent:async(trx,event)=>{
      await trx.updateTable('collaboration_integration_targets').set({lease_expires_at:new Date(0)}).where('workspace_id','=',workspaceId).execute();
      return writeCollaborationEvent(trx,event);
    }}});
  await assert.rejects(expiresDuringCommit.publishIntegration(input),{code:'COLLAB_INTEGRATION_FENCED'},'final SQL guard rejects a lease that expired after the in-memory check');
  const packageExpiresDuringCommit=createCollaborationTaskService({repository:createKyselyConversationRepository(database),crypto,packages:createTaskPackageBroker(),integrationLeasesEnabled:true,
    commandOperations:{writeEvent:async(trx,event)=>{
      await trx.updateTable('stored_objects').set({expires_at:new Date(0)}).where('id','=',input.objectId).execute();
      return writeCollaborationEvent(trx,event);
    }}});
  await assert.rejects(packageExpiresDuringCommit.publishIntegration(input),{code:'COLLAB_INTEGRATION_FENCED'},'expiry of the sealed pack between validation and CAS rolls back publication');
  assert.equal((await pool.query('SELECT id FROM collaboration_shared_publications')).rowCount,0);
  assert.equal((await pool.query("SELECT id FROM collaboration_events WHERE type='workspace.published'")).rowCount,0,'event and fanout cannot survive failed publication');
  assert.equal((await pool.query("SELECT state FROM stored_objects WHERE id='published-object'")).rows[0].state,'verified');
  assert.equal((await service.getIntegrationTarget(scope)).headCommit,head.headCommit,'receipt failure rolls back pack binding and head CAS');
  const racing=await Promise.allSettled([service.publishIntegration(input),service.publishIntegration({...input,clientCommandId:'competing-publish',publicationId:'competing-publication',objectId:'competing-object'})]);
  assert.equal(racing.filter(item=>item.status==='fulfilled').length,1);
  const winner=racing.findIndex(item=>item.status==='fulfilled'),publishedInput=winner===0?input:{...input,clientCommandId:'competing-publish',publicationId:'competing-publication',objectId:'competing-object'};
  const receipt=racing[winner].value;
  assert.equal(receipt.headCommit,git.commit);assert.equal(receipt.revision,head.revision+1);
  assert.equal((await service.getIntegrationTarget(scope)).lease,null);
  assert.deepEqual((await pool.query("SELECT s.user_id FROM user_sync_events s JOIN collaboration_events e ON e.id=s.event_id WHERE e.type='workspace.published'")).rows,[{user_id:owner.userId}]);
  assert.deepEqual(await service.publishIntegration(publishedInput),receipt,'lost response replay does not publish twice');
  assert.deepEqual(await service.publishIntegration({...publishedInput,clientCommandId:'fresh-publish-retry',generation:lease.generation+1}),receipt,'stable publication identity survives a new transport attempt');
  await assert.rejects(service.publishIntegration({...publishedInput,clientCommandId:'changed-publication',tree:'0'.repeat(40)}),{code:'COLLAB_INTEGRATION_PUBLICATION_CONFLICT'});
  const publication=(await service.getIntegrationPublication({account:owner,workspaceId})).publication;
  assert.equal(publication.git.commit,git.commit);assert.equal(publication.parentPublicationId,null);
  await assert.rejects(service.getIntegrationPublication({account:helper,workspaceId}),{code:'COLLAB_TASK_ACCESS_DENIED'});
  const stored=(await pool.query('SELECT * FROM collaboration_shared_publications')).rows[0];
  assert.equal(stored.content_ciphertext.includes(Buffer.from(git.ref)),false,'descriptors and evidence are encrypted at rest');
  await assert.rejects(Promise.resolve().then(()=>crypto.decryptTask({ciphertext:stored.content_ciphertext,keyVersion:stored.content_key_version,messageId:stored.id,conversationId:'chat',revision:1})),{code:'COLLAB_MESSAGE_CIPHERTEXT_INVALID'});
  await pool.query("UPDATE stored_objects SET state='revoked' WHERE id=$1",[publishedInput.objectId]);
  await assert.rejects(service.getIntegrationPublication({account:owner,workspaceId}),{code:'COLLAB_INTEGRATION_PACKAGE_UNAVAILABLE'});
  await assert.rejects(service.publishIntegration(publishedInput),{code:'COLLAB_INTEGRATION_PACKAGE_UNAVAILABLE'},'replaying a receipt rechecks published pack availability');
  await pool.query("UPDATE stored_objects SET state='bound' WHERE id=$1",[publishedInput.objectId]);
  await seed('incremental-object');
  const nextClaim={...scope,clientCommandId:'next-claim',expectedHead:git.commit,expectedRevision:receipt.revision};
  const nextLease=await service.claimIntegration(nextClaim);
  const nextGit={...git,ref:git.ref.replace(/f{64}$/,'0'.repeat(64)),commit:'0'.repeat(40),prerequisites:[git.commit,baselineCommit]};
  const nextInput={...input,...nextClaim,clientCommandId:'incremental-publish',leaseId:nextLease.lease.id,generation:nextLease.generation,
    publicationId:'incremental-publication',objectId:'incremental-object',git:nextGit,validation:{...input.validation,commit:nextGit.commit}};
  await pool.query("UPDATE stored_objects SET state='revoked' WHERE id=$1",[publishedInput.objectId]);
  await assert.rejects(service.publishIntegration(nextInput),{code:'COLLAB_INTEGRATION_PACKAGE_UNAVAILABLE'},'a delta cannot publish against an unavailable parent pack');
  await pool.query("UPDATE stored_objects SET state='bound' WHERE id=$1",[publishedInput.objectId]);
  const next=await service.publishIntegration(nextInput);
  assert.equal((await service.getIntegrationPublication({account:owner,workspaceId})).publication.parentPublicationId,receipt.publicationId);
  await pool.query("UPDATE stored_objects SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[publishedInput.objectId]);
  await assert.rejects(service.getIntegrationPublication({account:owner,workspaceId}),{code:'COLLAB_INTEGRATION_PACKAGE_UNAVAILABLE'},'latest delta checks the whole dependency chain');
  await pool.query('UPDATE stored_objects SET expires_at=NULL WHERE id=$1',[publishedInput.objectId]);
  await pool.query('UPDATE collaboration_shared_publications SET commit_id=$1 WHERE id=$2',['1'.repeat(40),next.publicationId]);
  await assert.rejects(service.getIntegrationPublication({account:owner,workspaceId}),{code:'COLLAB_INTEGRATION_PUBLICATION_UNAVAILABLE'},'encrypted metadata must agree with database routing');
  await pool.query('UPDATE collaboration_shared_publications SET commit_id=$1 WHERE id=$2',[nextGit.commit,next.publicationId]);
  await service.act({account:owner,taskId,clientCommandId:'publication-withdraw',action:'request_changes',deliveryId,expectedRevision:task.revision,reason:'next review'});
  assert.equal((await service.getIntegrationPublication({account:owner,workspaceId})).publication.id,next.publicationId,'durable shared history remains readable after its source task changes');
  await assert.rejects(service.publishIntegration(publishedInput),{code:'COLLAB_TASK_ACCESS_DENIED'});
  // Seed encrypted historical metadata to exercise the read bound without
  // pretending these synthetic descriptors are independently verified Git.
  let prior=(await service.getIntegrationPublication({account:owner,workspaceId})).publication;
  for(let index=3;index<=65;index++){
    const id=`historical-publication-${index}`,objectId=`historical-object-${index}`;
    await seed(objectId);await pool.query("UPDATE stored_objects SET state='bound',shared_workspace_id=$1 WHERE id=$2",[workspaceId,objectId]);
    const publication={...prior,id,publicationId:id,objectId,revision:index,expectedRevision:index-1,expectedHead:prior.git.commit,
      parentPublicationId:prior.id,git:{...prior.git,commit:index.toString(16).padStart(40,'0'),prerequisites:[prior.git.commit]}};
    const envelope=crypto.encryptIntegrationPublication({plaintext:Buffer.from(JSON.stringify(publication)),messageId:id,conversationId:'chat'});
    await database.insertInto('collaboration_shared_publications').values({id,workspace_id:workspaceId,conversation_id:'chat',owner_user_id:owner.userId,
      task_id:taskId,delivery_id:deliveryId,object_id:objectId,commit_id:publication.git.commit,revision:index,content_ciphertext:envelope.ciphertext,content_key_version:envelope.keyVersion}).execute();
    prior=publication;
  }
  assert.equal((await service.getIntegrationPublication({account:owner,workspaceId,publicationId:'historical-publication-64'})).publication.revision,64);
  await assert.rejects(service.getIntegrationPublication({account:owner,workspaceId,publicationId:prior.id}),{code:'COLLAB_INTEGRATION_FULL_PACK_REQUIRED'},'bounded ancestry requires a complete checkpoint pack after 64 publications');
  await pool.query("UPDATE user_devices SET status='revoked' WHERE device_id=$1",[owner.deviceId]);
  await assert.rejects(service.getIntegrationPublication({account:owner,workspaceId}),{code:'COLLAB_TASK_ACCESS_DENIED'});
  await pool.query("UPDATE user_devices SET status='active' WHERE device_id=$1",[owner.deviceId]);
  console.log('Shared publication PostgreSQL: fenced CAS, rollback, race, immutable replay, ciphertext purpose, pack retirement and durable owner-only history passed (verified objects/descriptors seeded).');
}
