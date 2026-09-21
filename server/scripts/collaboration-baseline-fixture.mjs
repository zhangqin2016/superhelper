import assert from 'node:assert/strict';
export async function verifySharedBaseline({service,pool,database,objects,crypto,owner,helper}){
  const workspaceId='baseline-workspace',other={userId:'observer',deviceId:'d_observer'};
  async function task(name,assignee,commit){
    for(const [id,user] of [[`${name}-input`,owner.userId],[`${name}-delivery`,assignee.userId]])
      await pool.query("INSERT INTO stored_objects(id,owner_user_id,conversation_id,scope_type,purpose,object_key,state,ciphertext_size,ciphertext_sha256,mime_type,original_name) VALUES($1,$2,'chat','personal','workspace',$1,'verified',500,$3,'application/octet-stream','task.bundle')",[id,user,'a'.repeat(64)]);
    const inputGit={version:1,format:'git-bundle-v2',ref:`refs/tasks/${'a'.repeat(64)}/baseline`,commit,prerequisites:[],sha256:'b'.repeat(64),sizeBytes:500};
    const {taskId}=await service.create({account:owner,clientCommandId:name,conversationId:'chat',sharedWorkspaceId:workspaceId,assigneeUserId:assignee.userId,inputSnapshotId:`${name}-input`,inputGit,title:name,objective:'Review',acceptanceCriteria:'Checked'});
    await service.act({account:assignee,clientCommandId:`${name}-accept`,taskId,action:'accept',expectedRevision:1});
    await service.act({account:assignee,clientCommandId:`${name}-submit`,taskId,action:'submit',expectedRevision:2,deliveryId:`${name}-delivery`,deliveryGit:{...inputGit,ref:`refs/tasks/${'a'.repeat(64)}/deliveries/${'b'.repeat(64)}`,commit:'e'.repeat(40),prerequisites:[commit]}});
    return {workspaceId,taskId,deliveryId:`${name}-delivery`};
  }
  const source=await task('baseline-old',helper,'1'.repeat(40));
  const request={account:owner,clientCommandId:'baseline-claim',...source,expectedHead:'1'.repeat(40),expectedRevision:0};
  await assert.rejects(service.claimIntegration({...request,clientCommandId:'baseline-bad',expectedHead:'0'.repeat(40)}));
  assert.equal((await pool.query('SELECT * FROM collaboration_shared_baselines WHERE workspace_id=$1',[workspaceId])).rowCount,0,'failed initial CAS cannot retain a baseline anchor');
  const held=await service.claimIntegration(request);
  assert.equal((await service.getIntegrationTarget({account:owner,...source})).baselineReady,true,'first successful claim must preserve a downloadable initial H');
  assert.equal((await pool.query('SELECT * FROM collaboration_shared_baselines WHERE workspace_id=$1',[workspaceId])).rowCount,1);
  await service.releaseIntegration({...request,clientCommandId:'baseline-release',leaseId:held.lease.id,generation:held.generation});
  const current=await task('baseline-new',other,'2'.repeat(40));
  await service.act({account:owner,clientCommandId:'baseline-cancel',taskId:source.taskId,action:'cancel',expectedRevision:3});
  await pool.query("UPDATE conversation_members SET status='removed' WHERE conversation_id='chat' AND user_id='helper'");
  const access=account=>database.transaction().execute(trx=>objects.authorizeObject(trx,{account,objectId:'baseline-old-input',action:'download'}));
  const initial=await service.getIntegrationTarget({account:owner,...current});assert.equal(initial.headCommit,'1'.repeat(40));assert.equal(initial.baselineReady,true);
  const {baseline}=await service.getIntegrationBaseline({account:owner,workspaceId});
  assert.equal(baseline.sourceTaskId,source.taskId);assert.equal(baseline.objectId,'baseline-old-input');assert.equal(baseline.git.commit,initial.headCommit);
  assert.equal((await access(owner)).ok,true,'owner baseline access outlives old task cancellation and assignee departure');
  assert.equal((await access(other)).ok,false,'a later assignee cannot download another task baseline');
  await assert.rejects(service.getIntegrationBaseline({account:other,workspaceId}),{code:'COLLAB_TASK_ACCESS_DENIED'});
  const row=(await pool.query('SELECT * FROM collaboration_shared_baselines WHERE workspace_id=$1',[workspaceId])).rows[0];
  assert.equal(row.content_ciphertext.includes(Buffer.from('baseline-old-input')),false);
  assert.throws(()=>crypto.decryptIntegrationPublication({ciphertext:row.content_ciphertext,keyVersion:row.content_key_version,messageId:workspaceId,conversationId:'chat'}),'baseline metadata has a separate encryption purpose');
  await pool.query('UPDATE collaboration_shared_baselines SET commit_id=$1 WHERE workspace_id=$2',['4'.repeat(40),workspaceId]);
  await assert.rejects(service.getIntegrationBaseline({account:owner,workspaceId}),{code:'COLLAB_INTEGRATION_BASELINE_UNAVAILABLE'});
  await pool.query('UPDATE collaboration_shared_baselines SET commit_id=$1 WHERE workspace_id=$2',[initial.headCommit,workspaceId]);
  // A legacy revision-zero target has no anchor. Bound restoration must find
  // the exact old B across finite pages, never adopt the new task's B.
  await pool.query('DELETE FROM collaboration_shared_baselines WHERE workspace_id=$1',[workspaceId]);
  const old=(await pool.query('SELECT * FROM collaboration_tasks WHERE id=$1',[source.taskId])).rows[0];
  const oldTask=JSON.parse(crypto.decryptTask({ciphertext:old.content_ciphertext,keyVersion:old.content_key_version,messageId:old.id,conversationId:'chat',revision:Number(old.revision)}));
  const decoys=[];
  for(let i=0;i<65;i++){
    const id=`000-baseline-${String(i).padStart(3,'0')}`,task={...oldTask,id,inputGit:{...oldTask.inputGit,commit:'3'.repeat(40)}};
    const envelope=crypto.encryptTask({plaintext:Buffer.from(JSON.stringify(task)),messageId:id,conversationId:'chat',revision:task.revision});
    decoys.push({...old,id,content_ciphertext:envelope.ciphertext,content_key_version:envelope.keyVersion});
  }
  await database.insertInto('collaboration_tasks').values(decoys).execute();
  const resolve={account:owner,clientCommandId:'baseline-resolve',...current,expectedHead:initial.headCommit,expectedRevision:0};
  const page=await service.resolveIntegrationBaseline(resolve);
  assert.equal(page.ready,false);assert.equal(page.nextCursor,'000-baseline-063');
  assert.deepEqual(await service.resolveIntegrationBaseline(resolve),page,'a lost page ACK replays the cursor without rescanning');
  assert.equal((await service.getIntegrationTarget({account:owner,...current})).headCommit,initial.headCommit);
  const restored=await service.resolveIntegrationBaseline({...resolve,clientCommandId:'baseline-resolve-next',afterTaskId:page.nextCursor});
  assert.equal(restored.ready,true);assert.equal((await service.getIntegrationBaseline({account:owner,workspaceId})).baseline.objectId,baseline.objectId);
  await assert.rejects(service.resolveIntegrationBaseline({...resolve,clientCommandId:'baseline-wrong-head',expectedHead:'4'.repeat(40)}),{code:'COLLAB_INTEGRATION_HEAD_CHANGED'});
  for(const patch of ["state='revoked'","expires_at=clock_timestamp()-interval '1 second'"]){
    await pool.query(`UPDATE stored_objects SET ${patch} WHERE id='baseline-old-input'`);
    assert.equal((await access(owner)).ok,false);
    await assert.rejects(service.getIntegrationBaseline({account:owner,workspaceId}),{code:'COLLAB_INTEGRATION_PACKAGE_UNAVAILABLE'});
    await assert.rejects(service.getIntegrationTarget({account:owner,...current}),{code:'COLLAB_INTEGRATION_PACKAGE_UNAVAILABLE'});
    await assert.rejects(service.resolveIntegrationBaseline(resolve),{code:'COLLAB_INTEGRATION_PACKAGE_UNAVAILABLE'},'old resolution receipt cannot bypass source retirement');
    await pool.query("UPDATE stored_objects SET state='bound',expires_at=NULL WHERE id='baseline-old-input'");
  }
  await pool.query('UPDATE collaboration_integration_targets SET revision=1 WHERE workspace_id=$1',[workspaceId]);
  await pool.query("UPDATE stored_objects SET state='revoked' WHERE id='baseline-old-input'");
  assert.equal((await service.getIntegrationTarget({account:owner,...current})).revision,1,'published H no longer depends on the initial task package');
  await pool.query('UPDATE collaboration_integration_targets SET revision=0 WHERE workspace_id=$1',[workspaceId]);
  await pool.query("UPDATE stored_objects SET state='bound' WHERE id='baseline-old-input'");
  await pool.query("UPDATE user_devices SET status='revoked' WHERE device_id=$1",[owner.deviceId]);
  assert.equal((await access(owner)).ok,false);await assert.rejects(service.getIntegrationBaseline({account:owner,workspaceId}));
  await pool.query("UPDATE user_devices SET status='active' WHERE device_id=$1",[owner.deviceId]);
  await pool.query("UPDATE conversation_members SET status='active' WHERE conversation_id='chat' AND user_id='helper'");
  console.log('Shared baseline PG: distinct task B, cancelled source, departed assignee, owner-only access, encryption separation and package/device retirement passed (seeded descriptors).');
}
