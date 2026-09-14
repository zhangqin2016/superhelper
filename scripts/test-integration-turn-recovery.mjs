import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {MessageStore}=require('../src/main/store/message-store');
const {enqueueIntegrationTurn,runIntegrationTurn}=require('../src/main/collaboration/integration-turn');
const {createTurnAdmissionMethods}=require('../src/main/turn-admission-runtime');
const {queueDispatchOptions}=require('../src/main/turn-queue-options');
const {recoveredQueueOptions}=require('../src/main/turn-queue-recovery');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'integration-turn-'));
let store,orchestrator;
function open(){
 store=new MessageStore(path.join(root,'messages.db'),path.join(root,'blobs'));
 const state={phase:'streaming',turnId:'foreground',queue:[]};
 orchestrator={ctx:{sessionManager:{findById:id=>({id,projectId:'project'}),admitQueuedTurnInput:(id,input,envelope)=>store.admitQueuedTurnInput(id,input,{ownerScope:'owner',queueRecoveryEnvelope:envelope})}},
  _state:()=>state,_emitQueue(){},...createTurnAdmissionMethods({log:{warn(){}},mergeDisplayFileMetadata:files=>files,newQueueId:randomUUID,newTurnId:randomUUID,queueDispatchOptions})};
}
try{
 open();const input={sessionId:'session',accountId:'owner',intentId:'integration:'+'b'.repeat(64),attempt:0};
 assert.equal((await enqueueIntegrationTurn(orchestrator,{...input,accountId:['owner']})).ok,false);
 const first=await enqueueIntegrationTurn(orchestrator,input);assert.equal(first.ok,true);
 const duplicate=await enqueueIntegrationTurn(orchestrator,input);assert.equal(duplicate.duplicate,true,'repeated delivery admission must be idempotent in actual SQLite');
 assert.equal(duplicate.turnId,first.turnId);assert.equal(orchestrator._state().queue.length,1);
 store.close();open();
 const replay=await enqueueIntegrationTurn(orchestrator,input);assert.equal(replay.duplicate,true);assert.equal(replay.turnId,first.turnId);assert.equal(orchestrator._state().queue.length,0);
 const persisted=store.getTurnInputByTurnId(first.turnId,'owner'),restored=recoveredQueueOptions(persisted,queueDispatchOptions);
 assert.equal(restored.options.recordUser,false);assert.equal(restored.options.queueVisibility,'background');
 assert.deepEqual(restored.options.localAssistant.collaborationIntegration,{accountId:'owner',intentId:input.intentId});
 assert.equal((await enqueueIntegrationTurn(orchestrator,{...input,attempt:1})).duplicate,undefined,'explicit next attempt has another identity');
 let owner='owner',called=0;
 const state={turnId:first.turnId,turnGeneration:1,taskAdmission:{ownerScope:'owner'}};
 const host={ctx:{sessionManager:{resolveTurnOwnerScope:()=>({ok:true,ownerScope:owner})},executeCollaborationIntegration:async()=>{called++;owner='other';return {ok:true,state:'published'};}}};
 await assert.rejects(runIntegrationTurn(host,{id:'session'},state,restored.options.localAssistant.collaborationIntegration),/FENCED/);
 assert.equal(called,1);await assert.rejects(runIntegrationTurn(host,{id:'session'},state,restored.options.localAssistant.collaborationIntegration),/FENCED/);assert.equal(called,1,'changed owner cannot execute another operation');
 owner=state.taskAdmission.ownerScope;
 host.ctx.executeCollaborationIntegration=async()=>({ok:true,state:'published',localState:'ready'});
 const local=await runIntegrationTurn(host,{id:'session'},state,restored.options.localAssistant.collaborationIntegration);
 assert.match(local.assistant,/not been applied|尚未写入|لم يُطبّق/,'candidate preparation cannot be described as completed workspace application');
 host.ctx.executeCollaborationIntegration=async()=>({ok:true,state:'published',localState:'ready',localValidationState:'failed'});
 const rejected=await runIntegrationTurn(host,{id:'session'},state,restored.options.localAssistant.collaborationIntegration);
 assert.equal(rejected.failed,true,'a published shared M does not mask failing private W prime checks');
 assert.match(rejected.assistant,/failed local checks|未通过本地检查|لم يجتز/);
 console.log('integration turn recovery: actual SQLite dedupe/reopen, restored closed background operation, explicit attempts and owner fences passed');
}finally{store?.close();fs.rmSync(root,{recursive:true,force:true});}
