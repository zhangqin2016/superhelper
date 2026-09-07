import assert from 'node:assert/strict';
import { createCollaborationTaskService } from '../server/src/services/collaboration/tasks.js';
import { createCollaborationMessageCrypto } from '../server/src/services/collaboration/message-crypto.js';

// Failure-injection adapter drives the REAL command runner and encryption.
// PostgreSQL lock scheduling and migration execution require separate tests.
let state={collaboration_tasks:[],collaboration_task_deliveries:[],receipts:{},events:[],fanout:[]};
let allowed=true, failCommit=false, clock=1;
function query(table,mode){
  const predicates=[];let value;
  const q={selectAll:()=>q,forUpdate:()=>q,where:(key,op,v)=>{assert.equal(op,'=');predicates.push(r=>r[key]===v);return q;},values:v=>{value=v;return q;},set:v=>{value=v;return q;},
    async executeTakeFirst(){const rows=state[table].filter(r=>predicates.every(p=>p(r)));if(mode==='update'){rows.forEach(r=>Object.assign(r,value));return{numUpdatedRows:BigInt(rows.length)};}return rows[0];},
    async execute(){if(mode==='insert'){if(state[table].some(r=>r.id===value.id))throw new Error('duplicate');state[table].push(value);}return[];}};return q;
}
const trx={selectFrom:t=>query(t,'select'),insertInto:t=>query(t,'insert'),updateTable:t=>query(t,'update')};
const database={transaction:()=>({execute:async fn=>{const snapshot=structuredClone(state);try{return await fn(trx);}catch(e){state=snapshot;throw e;}}})};
const key=i=>`${i.actorDeviceId}:${i.commandType}:${i.clientCommandId}`;
const commandOperations={
  findReceipt:async(_,i)=>state.receipts[key(i)],
  claimReceipt:async(_,i,f)=>{const receipt={requestFingerprint:f,state:'running'};state.receipts[key(i)]=receipt;return{inserted:true,receipt};},
  completeReceipt:async(_,i,c)=>{if(failCommit)throw new Error('injected receipt failure');state.receipts[key(i)]={...state.receipts[key(i)],...c,state:'completed'};},
  allocateRelationshipSequence:async()=>({seq:state.events.length+1}),
  writeEvent:async(_,e)=>{state.events.push(e);return e;},
  fanout:async(_,r)=>{state.fanout.push(r.recipientUserIds);return[];},writeRealtimeOutbox:async()=>{},
};
const repository={database,lockDevice:async()=>({ok:allowed}),lockConversationContext:async(_,c)=>({actorUserId:c.actorUserId,conversation:{scopeType:'personal',kind:'group',status:'active'},authorization:{conversationMembership:{user_id:c.actorUserId,status:'active'}}}),activeConversationMemberIds:async()=>['owner','helper','observer']};
const crypto=createCollaborationMessageCrypto({currentKekVersion:1,kekByVersion:{1:Buffer.alloc(32,7)}});
const packages={verifyInput:async()=>{},verifyDelivery:async({task,account,deliveryId})=>({id:deliveryId,taskId:task.id,inputSnapshotId:task.inputSnapshotId,actorUserId:account.userId,complete:true,manifestHash:'a'.repeat(64)})};
const service=createCollaborationTaskService({repository,crypto,packages,commandOperations,createId:()=> 'task1',now:()=>clock++});
const owner={userId:'owner',deviceId:'d-owner'},helper={userId:'helper',deviceId:'d-helper'};
const input={account:owner,clientCommandId:'create1',conversationId:'chat',assigneeUserId:'helper',inputSnapshotId:'snapshot',title:'预算',objective:'核查',acceptanceCriteria:'差异说明'};
const created=await service.create(input);
assert.equal(created.state,'offered');
assert.deepEqual(await service.create(input),created,'lost response replay returns original identity');
assert.equal(state.collaboration_tasks.length,1);
assert.deepEqual(state.fanout,[['helper','owner']],'observer receives no task events');
assert.equal(JSON.stringify(state.events).includes('核查'),false,'notifications omit private content');
const row=state.collaboration_tasks[0];
assert.equal(Buffer.from(row.content_ciphertext).includes(Buffer.from('核查')),false,'database stores an authenticated encrypted task envelope');
assert.throws(()=>crypto.decrypt({ciphertext:row.content_ciphertext,keyVersion:1,messageId:row.id,conversationId:row.conversation_id,revision:1}),'task ciphertext cannot be replayed as a chat message');
await assert.rejects(service.create({...input,title:'changed'}),{code:'IDEMPOTENCY_KEY_REUSED'});
const accepted=await service.act({account:helper,clientCommandId:'accept1',taskId:'task1',action:'accept',expectedRevision:1});
assert.equal(accepted.revision,2);
await assert.rejects(service.act({account:owner,clientCommandId:'submit-owner',taskId:'task1',action:'submit',expectedRevision:2,deliveryId:'v1'}),{code:'COLLAB_TASK_ACCESS_DENIED'});
failCommit=true;
await assert.rejects(service.act({account:helper,clientCommandId:'submit1',taskId:'task1',action:'submit',expectedRevision:2,deliveryId:'v1'}),/injected/);
assert.equal(state.collaboration_tasks[0].state,'active');assert.equal(state.collaboration_task_deliveries.length,0,'receipt failure rolls back delivery and task together');
failCommit=false;
await service.act({account:helper,clientCommandId:'submit1',taskId:'task1',action:'submit',expectedRevision:2,deliveryId:'v1'});
const approved=await service.act({account:owner,clientCommandId:'approve1',taskId:'task1',action:'approve',expectedRevision:3,deliveryId:'v1'});
assert.equal(approved.state,'accepted');
allowed=false;await assert.rejects(service.create(input),'revocation is checked even before replaying a completed receipt');
console.log('remote task service: real transaction runner, replay, encrypted projection, task-only fanout and rollback passed (in-memory adapter)');
