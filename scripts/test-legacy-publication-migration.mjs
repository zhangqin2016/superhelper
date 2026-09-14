import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{TaskGit}=require('../src/main/collaboration/task-git'),{createSharedGit}=require('../src/main/collaboration/shared-git');
const {createSharedPublication}=require('../src/main/collaboration/shared-publication'),{createIntegrationIntents}=require('../src/main/collaboration/integration-intents');
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store'),{LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring'),{createTaskRecords}=require('../src/main/collaboration/task-records');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'legacy-publication-'));
const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
let store,time=1000,checks=0;
const open=()=>{store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring,now:()=>time});};
const taskGit=new TaskGit({rootPath:path.join(root,'git'),gitOptions:{autoInstall:false}});
const snapshot=(name,text)=>{const snapshotRoot=path.join(root,name);fs.mkdirSync(snapshotRoot);fs.writeFileSync(path.join(snapshotRoot,'work.txt'),text);return {snapshotRoot,manifest:[{path:'work.txt',sizeBytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')}]};};
const validate=async candidate=>{checks++;return {ok:true,commit:candidate.commit,policyId:'checks',evidenceHash:createHash('sha256').update(`check-${checks}`).digest('hex')};};
try{
  open();store.replaceProjectionFromBootstrap({conversations:[{id:'chat',kind:'direct'}]});
  let intents=createIntegrationIntents({store,assertActive(){},now:()=>time}),records=createTaskRecords({store,assertActive(){}});
  const base=snapshot('base','B'),baseline=await taskGit.captureBaseline({taskId:'task',...base});
  const delivery=await taskGit.captureContribution({baseline,baseManifest:base.manifest,materializedPaths:['work.txt'],deliveryId:'delivery',...snapshot('change','D')});
  const input={conversationId:'chat',workspaceId:'workspace',taskId:'task',deliveryId:'delivery',targetId:'target',chain:'shared',projectId:'project',sessionId:'session',baselineCommit:baseline.commit,deliveryCommit:delivery.commit};
  const intent=intents.enqueue(input),publisher=()=>createSharedPublication({store,taskGit,assertActive(){},authorize:async()=>true,now:()=>time});
  const args={baseline,delivery,validationPolicyId:'checks',validate};
  const original=await publisher().run({...args,lease:intents.claim(intent.id,{workerId:'legacy'})});
  assert.equal(intents.get(intent.id).state,'completed');assert.equal(records.get(original.outboxId).state,'queued');
  const originalRef=await createSharedGit(taskGit).publication(original.candidate);
  const {createLegacyPublicationMigration}=require('../src/main/collaboration/legacy-publication-migration');
  const migration=enabled=>createLegacyPublicationMigration({store,assertActive(){},enabled,now:()=>time});
  await migration(false).recover();assert.equal(intents.get(intent.id).state,'completed','disabled remote protocol cannot revive completed work');
  const dbRun=store.db.run.bind(store.db);store.db.run=(sql,...args)=>{if(sql.startsWith('UPDATE task_integration_work SET state=\'pending\''))throw Error('migration-crash');return dbRun(sql,...args);};
  await assert.rejects(migration(true).recover(),/migration-crash/);store.db.run=dbRun;
  assert.equal(intents.get(intent.id).state,'completed');assert.equal(publisher().get(intent.id).state,'published','migration intent/journal/work changes roll back together');
  const migrating=migration(true);await migrating.recover();
  assert.equal(intents.get(intent.id).state,'pending');assert.equal(intents.get(intent.id).remotePublicationRequired,true);
  assert.equal(publisher().get(intent.id).validation,null,'old local evidence cannot silently become a new remote approval');
  assert.equal(records.get(original.outboxId).state,'queued','migration has no remote acknowledgement authority');
  assert.equal((await createSharedGit(taskGit).publication(original.candidate)).commit,originalRef.commit,'migration never rewrites local Git');
  const generation=store.db.get('SELECT generation FROM task_integration_work WHERE intent_id=?',intent.id).generation;
  await migrating.recover();assert.equal(store.db.get('SELECT generation FROM task_integration_work WHERE intent_id=?',intent.id).generation,generation);
  store.close();open();intents=createIntegrationIntents({store,assertActive(){},now:()=>time});records=createTaskRecords({store,assertActive(){}});
  await migration(true).recover();assert.equal(intents.get(intent.id).state,'pending');
  let lease=intents.claim(intent.id,{workerId:'downgrade'});
  await assert.rejects(publisher().run({...args,lease}),{code:'COLLAB_PUBLICATION_REMOTE_REQUIRED'});intents.release(lease);
  let acknowledged=false;
  const remote={recover:async()=>null,acquire:async()=>({commit:original.candidate.head}),publish:async candidate=>{
    if(!acknowledged)throw Object.assign(Error('no confirmation'),{code:'COLLAB_NETWORK_UNAVAILABLE'});
    return {workspaceId:input.workspaceId,publicationId:'remote-publication',headCommit:candidate.commit,revision:1};},
    canonical:async()=>({repository:originalRef.repository,ref:originalRef.ref,commit:original.candidate.commit})};
  lease=intents.claim(intent.id,{workerId:'remote'});await assert.rejects(publisher().run({...args,lease,remote}),{code:'COLLAB_NETWORK_UNAVAILABLE'});intents.release(lease);
  assert.equal(records.get(original.outboxId).state,'queued');assert.equal(intents.get(intent.id).state,'pending');assert.equal(checks,2);
  acknowledged=true;lease=intents.claim(intent.id,{workerId:'confirm-crash'});
  const migrationId=publisher().get(intent.id).legacyMigrationId,finishRun=store.db.run.bind(store.db);
  store.db.run=(sql,...args)=>{if(sql.startsWith('INSERT INTO task_workspace_records')&&args[1]===migrationId)throw Error('finish-crash');return finishRun(sql,...args);};
  await assert.rejects(publisher().run({...args,lease,remote}),/finish-crash/);store.db.run=finishRun;
  assert.equal(records.get(original.outboxId).state,'queued');assert.equal(records.get(migrationId).state,'pending');
  assert.equal(publisher().outbox('chat').filter(row=>row.state==='sent').length,0,'old supersession and new sent outbox share the completion transaction');
  assert.equal(intents.get(intent.id).state,'running');intents.release(lease);
  remote.recover=async journal=>journal.remoteReceipt;
  lease=intents.claim(intent.id,{workerId:'confirmed'});const confirmed=await publisher().run({...args,lease,remote});
  assert.equal(confirmed.state,'published');assert.equal(records.get(confirmed.outboxId).state,'sent');assert.notEqual(confirmed.outboxId,original.outboxId);
  const superseded=records.get(original.outboxId);assert.equal(superseded.state,'superseded');assert.equal(superseded.supersededBy,confirmed.outboxId);
  assert.deepEqual(superseded.content,records.get(confirmed.legacyMigrationId).originalOutbox.content);
  assert.equal(records.get(confirmed.legacyMigrationId).state,'confirmed');assert.equal(checks,2);
  await migration(true).recover();assert.equal(intents.get(intent.id).state,'completed');
  // Synthetic additional targets reuse the real immutable graph solely to
  // exercise bounded SQLite scheduling; no native work runs for these rows.
  const clones=[];
  let invalidId;
  for(let i=0;i<10;i++){
    const next=intents.enqueue({...input,targetId:`page-target-${i}`}),journalId=`shared-publication:${createHash('sha256').update(JSON.stringify(next.id)).digest('hex')}`;
    const outboxId=`publication-outbox:${createHash('sha256').update(JSON.stringify([next.id,original.candidate.commit])).digest('hex')}`;
    records.put(journalId,{...original,id:journalId,intentId:next.id,outboxId,...(i===9?{publication:{commit:'0'.repeat(40)}}:{})});
    records.put(outboxId,{...records.get(confirmed.legacyMigrationId).originalOutbox,id:outboxId,intentId:next.id});
    records.put(next.id,{...next,state:'completed'});store.db.run("UPDATE task_integration_work SET state='done' WHERE intent_id=?",next.id);if(i===9)invalidId=next.id;else clones.push(next.id);
  }
  const paged=migration(true);await paged.recover();
  const firstPage=clones.filter(id=>intents.get(id).state==='pending').length;assert.ok(firstPage>0&&firstPage<=8);
  await paged.recover();await paged.recover();assert.equal(clones.filter(id=>intents.get(id).state==='pending').length,9);
  assert.equal(intents.get(invalidId).state,'completed');assert.equal(store.db.get('SELECT code FROM task_integration_work WHERE intent_id=?',invalidId).code,'COLLAB_PUBLICATION_MIGRATION_INVALID');
  const broken=require('../src/main/collaboration/integration-status').taskIntegration({id:'task',currentDeliveryId:'delivery',sharedWorkspaceId:'workspace'},[intents.get(invalidId)],new Map([[invalidId,store.db.get('SELECT * FROM task_integration_work WHERE intent_id=?',invalidId)]]));
  assert.equal(broken.status.stage,'failed');assert.equal(broken.status.canRetry,false,'inconsistent history is visible but never republished');
  store.db.run("UPDATE task_integration_work SET state='waiting',code='COLLAB_PUBLICATION_REMOTE_REQUIRED',attempts=3 WHERE intent_id=?",clones[0]);
  const {createIntegrationWorker}=require('../src/main/collaboration/integration-worker');
  const disabledWorker=createIntegrationWorker({store,assertActive(){},getWorkflow:()=>({})});disabledWorker.stop();
  assert.equal(store.db.get('SELECT state FROM task_integration_work WHERE intent_id=?',clones[0]).state,'waiting');
  const enabledWorker=createIntegrationWorker({store,assertActive(){},getWorkflow:()=>({}),remotePublicationEnabled:true});enabledWorker.stop();
  assert.equal(store.db.get('SELECT state FROM task_integration_work WHERE intent_id=?',clones[0]).state,'pending','restoring protocol availability wakes downgraded pending work');
  console.log('legacy publication: real Git/SQLite local completion, atomic bounded requeue, reopen, downgrade fence, fresh checks and supersession only after confirmed publication passed (remote API adapter).');
}finally{store?.close();fs.rmSync(root,{recursive:true,force:true});}
