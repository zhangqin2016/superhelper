import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store');
const {LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createIntegrationIntents}=require('../src/main/collaboration/integration-intents');
const {createIntegrationAdmission}=require('../src/main/collaboration/integration-admission');
const {integrationTurnId}=require('../src/main/collaboration/integration-turn');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'local-retry-'));
const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
let store,intents,admission,now=1000,ready=false,result='waiting',calls=0,runs=0,request;
const seen=new Set();
const input={conversationId:'chat',workspaceId:'workspace',taskId:'task',deliveryId:'delivery',targetId:'target',chain:'shared',sessionId:'session',projectId:'project',baselineCommit:'a'.repeat(40),deliveryCommit:'b'.repeat(40)};
function open(){
 store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring,now:()=>now});intents=createIntegrationIntents({store,assertActive(){},now:()=>now});
 admission=createIntegrationAdmission({store,assertActive(){},now:()=>now,getWorkflow:()=>({authorizeIntegration:async()=>true,localApplicationStatus:()=>({state:'pending',ready})}),
  enqueue:async value=>{const turnId=integrationTurnId(value);if(!seen.has(turnId)){seen.add(turnId);calls++;}request=value;return{ok:true,turnId,durableStatus:'admitted'};},
  worker:{runIntent:async(value,execution)=>{execution.assertActive();runs++;assert.equal(intents.get(value.intentId).state,'completed','local retry must not reopen shared publication');return{ok:true,state:'published',localState:result};}}});
}
try{
 open();store.replaceProjectionFromBootstrap({conversations:[{id:'chat',kind:'direct'}]});const intent=intents.enqueue(input);intents.complete(intents.claim(intent.id,{workerId:'shared',leaseMs:10000}));
 await admission.recover();assert.equal(calls,0,'busy foreground must not flood the turn queue');
 assert.equal(store.db.get('SELECT code FROM task_integration_work').code,'COLLAB_LOCAL_APPLICATION_PENDING');
 admission.stop();store.close();now+=3000;ready=true;open();await admission.recover();assert.equal(calls,1);
 const first=request;
 store.db.run('UPDATE task_integration_work SET generation=generation+1,next_attempt_at=0');
 await admission.recover();assert.equal(request.attempt,first.attempt,'shared completion changes the work generation while its original local phase still owns the turn');
 await admission.execute(first,{turnId:integrationTurnId(first),assertActive(){}});
 now+=3000;ready=false;await admission.recover();assert.equal(calls,1,'a renewed foreground hold does not enqueue duplicate turns');
 now+=3000;ready=true;await admission.recover();assert.equal(calls,2);assert.equal(request.attempt,first.attempt+1);
 result='applied';await admission.execute(request,{turnId:integrationTurnId(request),assertActive(){}});
 assert.equal(store.db.get('SELECT code FROM task_integration_work').code,'COLLAB_LOCAL_APPLICATION_APPLIED');
 admission.stop();store.close();now+=3000;open();await admission.recover();assert.equal(calls,2);assert.equal(runs,2);
 console.log('PASS local retry: completed-shared recovery, idle admission, stable waiting across restart and no replay after applied');
}finally{admission?.stop();store?.close();fs.rmSync(root,{recursive:true,force:true});}
