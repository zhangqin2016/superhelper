import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createRemotePublication}=require('../src/main/collaboration/remote-publication');
const {CollaborationStore}=require('../src/main/collaboration/collaboration-store'),{LocalCollaborationKeyring}=require('../src/main/collaboration/local-keyring');
const {createTaskRecords}=require('../src/main/collaboration/task-records');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'baseline-recovery-'));
const keyring=new LocalCollaborationKeyring({filePath:path.join(root,'keys'),safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()}});
let store,remote;const input={workspaceId:'workspace',conversationId:'chat',taskId:'task',deliveryId:'delivery'};
let calls=0,lost=true,ready=false,claims=0,unavailable=false;const receipts=new Map(),requests=[];
const target=()=>({workspaceId:'workspace',headCommit:'a'.repeat(40),revision:0,initialized:true,baselineReady:ready});
const client={getIntegrationTarget:async()=>target(),claimIntegration:async()=>{claims++;throw Object.assign(Error('stop at claim'),{code:'CLAIM_PROBE'});},
  resolveIntegrationBaseline:async request=>{requests.push(request);if(receipts.has(request.clientCommandId))return receipts.get(request.clientCommandId);
    calls++;const result={workspaceId:'workspace',headCommit:'a'.repeat(40),ready:Boolean(request.afterTaskId)&&!unavailable,nextCursor:request.afterTaskId||unavailable?null:'task-page-64'};
    ready=result.ready;receipts.set(request.clientCommandId,result);if(lost){lost=false;throw Object.assign(Error('lost page ACK'),{code:'NETWORK'});}return result;}};
function open(intentId='intent'){
  store=new CollaborationStore({dbPath:path.join(root,'db'),accountId:'owner',keyring});
  if(!store.listConversations().length)store.replaceProjectionFromBootstrap({conversations:[{id:'chat',scopeId:'personal',kind:'group'}]});
  remote=createRemotePublication({store,taskGit:{},client,transfers:{sharedFiles:{}},deviceId:'device',input,intentId,assertActive(){},assertAccountActive(){},authorize:async()=>true});
}
async function close(){await remote.close();remote=null;store.close();store=null;}
try{
  open();await assert.rejects(remote.acquire(),{code:'NETWORK'});assert.equal(claims,0);await close();
  open();await assert.rejects(remote.acquire(),{code:'COLLAB_REMOTE_PUBLICATION_BASELINE_PENDING'});assert.equal(calls,1,'lost ACK replay must not scan another page');
  assert.equal(requests[0].clientCommandId,requests[1].clientCommandId);await close();
  open();await assert.rejects(remote.acquire(),{code:'CLAIM_PROBE'});assert.equal(calls,2);assert.equal(claims,1);
  assert.equal(requests[2].afterTaskId,'task-page-64');assert.notEqual(requests[2].clientCommandId,requests[1].clientCommandId);
  assert.equal(createTaskRecords({store,assertActive(){}}).list('chat').find(row=>row.kind==='remote-baseline-resolution').state,'ready');await close();
  ready=false;unavailable=true;open('no-source');
  await assert.rejects(remote.acquire(),{code:'COLLAB_REMOTE_PUBLICATION_BASELINE_UNAVAILABLE'});const stoppedCalls=calls;
  await assert.rejects(remote.acquire(),{code:'COLLAB_REMOTE_PUBLICATION_BASELINE_UNAVAILABLE'});assert.equal(calls,stoppedCalls,'an exhausted scan is explicit and never resets H or loops');
  ready=true;await assert.rejects(remote.acquire(),{code:'CLAIM_PROBE'});assert.equal(claims,2,'a fresh target anchored by another device supersedes old unavailable state');
  console.log('remote baseline recovery: encrypted cursor across reopen, lost page ACK, one bounded page per attempt, no premature lease and explicit unavailable source passed (API fixtures).');
}finally{if(remote)await close();fs.rmSync(root,{recursive:true,force:true});}
