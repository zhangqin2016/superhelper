import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createIntegrationIntents}=require('../src/main/collaboration/integration-intents');
const {createIntegrationAdmission}=require('../src/main/collaboration/integration-admission');
const {integrationTurnId}=require('../src/main/collaboration/integration-turn');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'integration-admission-'));
const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
let store,scheduler,intents,now=1000,calls=0,runs=0,dropAck=true,terminal=null,live=false,deny=false,onEnqueue=null,notReady=false;
const queued=new Map();
const input={conversationId:'chat',workspaceId:'workspace',taskId:'task',deliveryId:'delivery',targetId:'target',chain:'shared',sessionId:'session',projectId:'project',baselineCommit:'a'.repeat(40),deliveryCommit:'b'.repeat(40)};
function open(){
 store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring,now:()=>now});intents=createIntegrationIntents({store,assertActive(){},now:()=>now});
 scheduler=createIntegrationAdmission({store,assertActive(){},getWorkflow:()=>({authorizeIntegration:async()=>{if(deny)throw Object.assign(Error('denied'),{code:'COLLAB_TASK_ACCESS_DENIED'});return true;}}),
   enqueue:async request=>{calls++;if(notReady)return {ok:false,error:'COLLAB_INTEGRATION_NOT_READY'};const turnId=integrationTurnId(request),duplicate=queued.has(turnId);queued.set(turnId,request);onEnqueue?.();if(dropAck){dropAck=false;throw Error('lost acknowledgement');}return {ok:true,turnId,duplicate,durableStatus:terminal||'admitted',outcomeUnknown:terminal==='outcome_unknown',active:live};},
   worker:{async runIntent(request,execution){runs++;execution.assertActive();return {ok:true,state:'validation_required'};}},now:()=>now});
}
try{
 open();store.replaceProjectionFromBootstrap({conversations:[{id:'chat',kind:'direct'}]});const intent=intents.enqueue(input);
 await Promise.all([scheduler.recover(),scheduler.recover()]);assert.equal(calls,1);assert.equal(queued.size,1);assert.equal(runs,0,'admission cannot execute work outside its owning turn');
 const saved=scheduler.get(intent.id);assert.equal(saved.turnId,[...queued.keys()][0]);
 assert.doesNotMatch(JSON.stringify(store.db.all('SELECT payload_envelope_json FROM task_workspace_records')),/turn_collaboration_|"sessionId"|"attempt"/,'admission context stays scope-encrypted');
 scheduler.stop();store.close();now+=61000;open();await scheduler.recover();assert.equal(queued.size,1,'lost ACK and restart reuse the durable turn identity');
 assert.equal(scheduler.get(intent.id).attempt,saved.attempt);
 const request={accountId:'owner',intentId:intent.id,sessionId:'session'},execution={turnId:saved.turnId,assertActive(){}};
 await assert.rejects(scheduler.execute({...request,accountId:'other'},execution));
 await assert.rejects(scheduler.execute({...request,sessionId:'other'},execution));
 await assert.rejects(scheduler.execute(request,{...execution,turnId:'stale'}));assert.equal(runs,0);
 assert.equal((await scheduler.execute(request,execution)).state,'validation_required');assert.equal(runs,1);
 terminal='cancelled';now+=61000;await scheduler.recover();
 assert.equal(store.db.get('SELECT state FROM task_integration_work').state,'waiting');const cancelled=scheduler.get(intent.id);
 now+=61000;await scheduler.recover();assert.equal(scheduler.get(intent.id).attempt,cancelled.attempt,'cancelled turns do not restart themselves');
 store.db.run("UPDATE task_integration_work SET state='pending',next_attempt_at=0,code=NULL,attempts=0");terminal=null;
 await scheduler.recover();assert.equal(scheduler.get(intent.id).attempt,cancelled.attempt+1,'explicit retry creates one new attempt');
 await assert.rejects(scheduler.execute(request,execution),'old queued turn is fenced after retry');
 terminal='outcome_unknown';live=true;now+=61000;await scheduler.recover();const running=scheduler.get(intent.id);
 assert.equal(running.attempt,cancelled.attempt+1,'an observed live turn is not replaced on an unknown receipt');
 live=false;now+=61000;await scheduler.recover();now+=61000;terminal=null;await scheduler.recover();
 assert.equal(scheduler.get(intent.id).attempt,running.attempt+1,'restart-only unknown dispatch can retry under a new fenced identity');
 const beforeContention=scheduler.get(intent.id).attempt;
 terminal='completed';now+=61000;await scheduler.recover();assert.equal(store.db.get('SELECT state FROM task_integration_work').state,'pending');
 terminal=null;now+=61000;await scheduler.recover();assert.equal(scheduler.get(intent.id).attempt,beforeContention+1,'completed turn with work still pending (lease contention) retries rather than looking cancelled');
 deny=true;await assert.rejects(scheduler.execute(request,{...execution,turnId:scheduler.get(intent.id).turnId}));assert.equal(runs,1);
 deny=false;const raced=intents.enqueue({...input,workspaceId:'raced',targetId:'raced'});
 onEnqueue=()=>{store.db.run("UPDATE task_integration_work SET generation=generation+1,state='waiting',code='COLLAB_INTEGRATION_VALIDATION_REQUIRED' WHERE intent_id=?",raced.id);onEnqueue=null;};
 await scheduler.recover();assert.equal(store.db.get('SELECT state FROM task_integration_work WHERE intent_id=?',raced.id).state,'waiting','late admission ACK cannot overwrite completed worker state');
 const boot=intents.enqueue({...input,workspaceId:'boot',targetId:'boot'});notReady=true;await scheduler.recover();
 const bootRow=store.db.get('SELECT * FROM task_integration_work WHERE intent_id=?',boot.id);assert.equal(bootRow.state,'pending');assert.equal(bootRow.attempts,0,'native orchestrator bootstrap does not exhaust the retry budget');
 notReady=false;now+=2000;await scheduler.recover();assert.equal(queued.has(scheduler.get(boot.id).turnId),true);
 scheduler.stop();await assert.rejects(scheduler.execute(request,execution));
 console.log('integration admission: encrypted SQLite intent/ACK gap recovery, explicit attempts, cancellation/live-unknown handling and account/session/turn/authorization fences passed');
}finally{scheduler?.stop();store?.close();fs.rmSync(root,{recursive:true,force:true});}
