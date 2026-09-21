import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createLocalMaterializationApplication}=require('../src/main/collaboration/local-materialization-application');
const {createLocalContributionUndo}=require('../src/main/collaboration/local-contribution-undo');
const {createLocalMaterialization,localMaterializationJobId}=require('../src/main/collaboration/local-materialization');
const {createLocalWriter}=require('../src/main/collaboration/local-writer');
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createTaskRecords}=require('../src/main/collaboration/task-records');
const {createTaskRecovery}=require('../src/main/collaboration/task-recovery');
const {createTaskWorkflow}=require('../src/main/collaboration/task-workflow');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'local-undo-'));
const hash=v=>createHash('sha256').update(v).digest('hex');
const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
const store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring});
store.replaceProjectionFromBootstrap({conversations:[{id:'chat',kind:'direct'}]});
const records=createTaskRecords({store,assertActive(){}}),recoveries=createTaskRecovery({store,assertActive(){}});
const writer=createLocalWriter({filePath:path.join(root,'writer.sqlite')});
let active=true,policy='policy',fault=false;
const input={conversationId:'chat',taskId:'task',deliveryId:'delivery',workspaceId:'workspace',targetId:'target',projectId:'project',sessionId:'session'};
const shared={ref:'shared',commit:'b'.repeat(40),remoteRevision:1};
// Git merge-file treats adjacent hunks as conflicts; keep the private head and the contributed tail apart.
const BEFORE='private\nline2\nline3\nline4\n',AFTER=BEFORE+'shared\n',CONFLICT=AFTER.replace('shared','shared edited'),DISJOINT='PRIVATE'+AFTER.slice(7),DISJOINT_RESULT='PRIVATE'+BEFORE.slice(7);
const read=(job,name='work.txt')=>fs.readFileSync(path.join(job.binding.localRoot,name),'utf8');
const write=(job,text,name='work.txt')=>fs.writeFileSync(path.join(job.binding.localRoot,name),text);
function fixture(name,{deleted=false,id=name,baseId=name+'-base'}={}){
 const localRoot=path.join(root,name+'-w'),snapshotRoot=path.join(root,name+'-candidate');fs.mkdirSync(localRoot);fs.mkdirSync(snapshotRoot);
 const entry=(dir,file,text)=>{fs.writeFileSync(path.join(dir,file),text);return {path:file,sha256:hash(text),sizeBytes:Buffer.byteLength(text)};};
 const currentManifest=[entry(localRoot,'work.txt',BEFORE)],manifestAfter=[entry(snapshotRoot,'work.txt',AFTER)],paths=['work.txt'];
 if(deleted){currentManifest.push(entry(localRoot,'gone.txt','keep me'));fs.chmodSync(path.join(localRoot,'gone.txt'),0o640);paths.push('gone.txt');}
 // Same key order as local-materialization.prepare so derived base bindings hash identically.
 const stat=fs.statSync(localRoot);
 const binding={accountId:'owner',deviceId:'device',workspaceId:input.workspaceId,projectId:input.projectId,sessionId:input.sessionId,targetId:input.targetId,localRoot,rootIdentity:`${stat.dev}:${stat.ino}`};
 const base=records.put(baseId,{kind:'local-materialization-base',conversationId:'chat',binding,generation:0,remoteRevision:0,revision:{ref:'base',commit:'a'.repeat(40)}});
 const report={state:'passed',candidateUnchanged:true,token:name,fingerprint:name,checkPolicyId:'policy',privateCommit:'c'.repeat(40)};
 const evidenceHash=hash(JSON.stringify(report)),evidence=records.put(name+'-validation',{conversationId:'chat',state:'passed',evidenceHash,report});
 return records.put(id,{kind:'local-materialization',conversationId:'chat',taskId:'task',deliveryId:'delivery',intentId:name,state:'ready',token:name,fingerprint:name,binding,baseId:base.id,baseGeneration:0,baseRemoteRevision:0,baseRevision:base.revision,
  sharedRevision:shared,candidate:{snapshotRoot,manifest:manifestAfter,currentManifest,paths,conflicts:[]},
  validation:{state:'passed',evidenceId:evidence.id,evidenceHash,privateCommit:report.privateCommit,checkPolicyId:'policy'}});
}
const options=journalRoot=>({store,writer,journalRoot,assertActive(){assert.ok(active);},authorize:async()=>true,getPolicy:()=>({id:policy}),beforeReceipt(){if(fault)throw Error('receipt fault');}});
const application=createLocalMaterializationApplication(options(path.join(root,'recovery')));
const undo=createLocalContributionUndo({store,writer,journalRoot:path.join(root,'recovery'),destinationRoot:path.join(root,'inverse'),assertActive(){assert.ok(active);},beforeReceipt(){if(fault)throw Error('undo receipt fault');}});
const applied=async job=>{await application.apply({job,input});return records.get(job.id).applicationId;};
try{
 const job=fixture('undo');const original=await applied(job),baseBefore=records.get(job.baseId);
 assert.equal(recoveries.get(original).jobId,job.id,'personal receipt remembers its job for undone projection');
 assert.equal((await undo.undo(original)).state,'undone');
 assert.equal(read(job),BEFORE);
 assert.equal(recoveries.get(original).state,'undone');assert.equal(records.get(job.id).state,'undone');
 assert.deepEqual(records.get(job.baseId),baseBefore,'undo is a new private change; shared synchronization baseline must not rewind');
 const inverse=recoveries.get(recoveries.get(original).undoApplicationId);
 assert.equal(inverse.kind,'inverse');assert.equal(inverse.undoOf,original);assert.equal(inverse.state,'applied');
 write(job,'later after undo');
 assert.equal((await undo.undo(original)).state,'undone');assert.equal(read(job),'later after undo','replayed undo must not erase later edits');
 await assert.rejects(undo.recover(inverse.id),/NOT_RECOVERABLE/,'a completed undo is history, never rolled back over later edits');
 await assert.rejects(application.apply({job:records.get(job.id),input}),/FENCED/,'an undone job cannot be re-applied through the application path');

 // Disjoint later edits survive; an edit touching the contributed line blocks the undo without writing.
 const edited=fixture('edited');const editedId=await applied(edited);
 write(edited,CONFLICT);
 const blocked=await undo.undo(editedId);
 assert.equal(blocked.ok,false);assert.equal(blocked.state,'conflicts');assert.equal(blocked.code,'COLLAB_LOCAL_UNDO_CONFLICT');
 assert.deepEqual(blocked.conflicts.map(c=>c.path),['work.txt']);
 assert.equal(read(edited),CONFLICT,'conflicting undo leaves W untouched');
 assert.equal(recoveries.get(editedId).state,'applied');assert.equal(recoveries.get(editedId).undoApplicationId,undefined);
 assert.equal(fs.readdirSync(path.join(root,'inverse')).length,1,'conflicting candidates are cleaned up; only the completed undo staging remains');
 write(edited,DISJOINT);
 assert.equal((await undo.undo(editedId)).state,'undone');assert.equal(read(edited),DISJOINT_RESULT,'disjoint later edits survive the undo');

 // Files the contribution deleted return with their original mode.
 const removed=fixture('removed',{deleted:true});const removedId=await applied(removed);
 assert.equal(fs.existsSync(path.join(removed.binding.localRoot,'gone.txt')),false);
 assert.equal((await undo.undo(removedId)).state,'undone');
 assert.equal(read(removed,'gone.txt'),'keep me');assert.equal(fs.statSync(path.join(removed.binding.localRoot,'gone.txt')).mode&0o777,0o640,'restored deleted file keeps its recorded mode');
 assert.equal(recoveries.get(recoveries.get(removedId).undoApplicationId).input.fileModes['gone.txt'],0o640,'mode travels inside the immutable binding');

 // Interrupted inverse: original stays applied, W recovers to the pre-inverse state, then a fresh attempt succeeds.
 const broken=fixture('fault');const brokenId=await applied(broken);
 fault=true;await assert.rejects(undo.undo(brokenId),/undo receipt fault/);fault=false;
 assert.equal(recoveries.get(brokenId).state,'applied');assert.equal(records.get(broken.id).state,'applied');
 const inverseId=recoveries.get(brokenId).undoApplicationId;assert.equal(recoveries.get(inverseId).journal.state,'applying');
 await assert.rejects(undo.undo(brokenId),/RECOVERY_REQUIRED/,'an interrupted inverse must be recovered before another attempt');
 await undo.recover(inverseId);assert.equal(read(broken),AFTER);
 assert.equal((await undo.undo(brokenId)).state,'undone','recovered inverse may be retried as a fresh durable attempt');
 assert.notEqual(recoveries.get(brokenId).undoApplicationId,inverseId);
 const busy=fixture('busy-undo');const busyId=await applied(busy);
 await writer.runAsync(async()=>{await assert.rejects(undo.undo(busyId),/BUSY/);});
 assert.equal(read(busy),AFTER);assert.equal(recoveries.get(busyId).state,'applied');

 // The same shared M never re-applies an undone contribution; a newer M starts a fresh candidate.
 const intentId='reapply',jobId=localMaterializationJobId(intentId);
 const derivedBase=`local-materialization-base:${hash(JSON.stringify(['device',input.workspaceId,input.targetId]))}`;
 const same=fixture('reapply',{id:jobId,baseId:derivedBase});const sameId=await applied(same);
 assert.equal((await undo.undo(sameId)).state,'undone');
 const materialization=createLocalMaterialization({store,taskGit:{ensure(){throw Error('must not touch git');}},rootPath:path.join(root,'materialization'),deviceId:'device',assertActive(){},authorize:async()=>true});
 const published=commit=>({state:'published',intentId,candidate:{state:'ready',ref:'shared',commit,head:'a'.repeat(40)},publication:{commit},remoteReceipt:{headCommit:commit,workspaceId:input.workspaceId,revision:commit===shared.commit?1:2}});
 const prepared=await materialization.prepare({intentId,input:{...input,baselineCommit:'a'.repeat(40)},localRoot:same.binding.localRoot,baseline:{ref:'base',commit:'a'.repeat(40)},published:published(shared.commit)});
 assert.equal(prepared.state,'undone');assert.equal(read(same),BEFORE,'same shared M returns history instead of re-applying');
 await assert.rejects(materialization.prepare({intentId,input:{...input,baselineCommit:'a'.repeat(40)},localRoot:same.binding.localRoot,baseline:{ref:'base',commit:'a'.repeat(40)},published:published('d'.repeat(40))}),/must not touch git/,'a newer shared M prepares a fresh private candidate');

 // Workflow entry: identity-only rollback of a materialization runs the undo; projections hide inverse internals.
 const managed=path.join(root,'managed'),journalRoot=path.join(managed,hash('owner'),'recovery');fs.mkdirSync(journalRoot,{recursive:true,mode:0o700});
 const task={id:'task',conversationId:'chat',requesterUserId:'owner',assigneeUserId:'helper',state:'accepted',acceptedDeliveryId:'delivery',currentDeliveryId:'delivery',deliveries:[{id:'delivery'}]};
 const workflowOptions={store,assertActive(){},tasks:{get:async()=>({ok:true,task})},client:{},transfers:{},rootPath:managed,taskGitProtocol:1,sharedPublicationProtocol:1,localApplicationWriter:writer};
 const managedApplication=createLocalMaterializationApplication(options(journalRoot));
 const flow=fixture('flow');await managedApplication.apply({job:flow,input});const flowId=records.get(flow.id).applicationId;
 const workflow=createTaskWorkflow(workflowOptions);await workflow.recoverPending();
 const before=await workflow.run({operation:'drafts',conversationId:'chat'});
 assert.equal(before.applications.find(row=>row.applicationId===flowId).state,'applied');
 const result=await workflow.run({operation:'rollback',conversationId:'chat',taskId:'task',applicationId:flowId});
 assert.equal(result.ok,true);assert.equal(result.state,'undone');assert.equal(read(flow),BEFORE);
 const after=await workflow.run({operation:'drafts',conversationId:'chat'});
 assert.equal(after.applications.find(row=>row.applicationId===flowId).state,'undone');
 assert.equal(after.applications.some(row=>row.applicationId.startsWith('undo-')),false,'inverse attempts never surface as applications');
 assert.equal((await workflow.run({operation:'rollback',conversationId:'chat',taskId:'task',applicationId:flowId})).state,'undone','workflow replay is history');
 assert.equal((await workflow.run({operation:'recoveries'})).applications.some(row=>[flowId,recoveries.get(flowId).undoApplicationId].includes(row.applicationId)),false,'completed undo is not recovery work');
 // Interrupted inverse under the workflow journal: listed for personal recovery, rolled back by identity, and by restart reconciliation.
 const crash=fixture('crash');await managedApplication.apply({job:crash,input});const crashId=records.get(crash.id).applicationId;
 const faulty=createLocalContributionUndo({store,writer,journalRoot,destinationRoot:path.join(root,'inverse-managed'),assertActive(){},beforeReceipt(){throw Error('crash before receipt');}});
 await assert.rejects(faulty.undo(crashId),/crash before receipt/);const crashInverse=recoveries.get(crashId).undoApplicationId;
 const listed=(await workflow.run({operation:'recoveries'})).applications;
 assert.deepEqual(listed.filter(row=>row.applicationId===crashInverse).map(row=>row.state),['applying']);
 assert.equal(listed.some(row=>row.applicationId===crashId),false,'the still-applied original is not offered for whole-file rollback');
 assert.equal((await workflow.run({operation:'rollback',conversationId:'chat',taskId:'task',applicationId:crashInverse})).state,'rolled_back');
 assert.equal(read(crash),AFTER,'inverse recovery returns to the pre-undo W, never to before the contribution');
 assert.equal(recoveries.get(crashId).state,'applied');
 await assert.rejects(faulty.undo(crashId),/crash before receipt/);const secondInverse=recoveries.get(crashId).undoApplicationId;
 assert.equal(recoveries.get(secondInverse).journal.state,'applying');
 write(flow,'edited after undo');
 const restarted=createTaskWorkflow(workflowOptions);await restarted.recoverPending();
 assert.equal(recoveries.get(secondInverse).state,'rolled_back','startup reconciliation rolls back an interrupted inverse');
 assert.equal(read(crash),AFTER);assert.equal(recoveries.get(crashId).state,'applied');
 assert.equal(recoveries.get(flowId).state,'undone');assert.equal(read(flow),'edited after undo','startup reconciliation never touches undone history');
 const revoked=fixture('revoked');const revokedId=await applied(revoked);
 // Delete only this synthetic conversation projection: scoped records become inaccessible.
 store.db.run('DELETE FROM conversations WHERE account_id = ? AND id = ?',store.accountId,'chat');
 assert.equal((await undo.undo(revokedId)).state,'undone','personal recovery survives loss of remote scope');
 assert.equal(read(revoked),BEFORE);
 console.log('PASS durable contribution undo: atomic personal receipt, unchanged A, replay, undo conflicts, restored modes, interrupted inverse recovery, writer admission, no re-apply for the same M, workflow rollback/projections/restart, revoked conversation');
}finally{store.close();fs.rmSync(root,{recursive:true,force:true});}
