import {randomUUID} from 'node:crypto';
import {sql} from 'kysely';
import {runCollaborationCommand} from './command-runner.js';
import {CollaborationCommandError} from './idempotency.js';
import contract from './integration-lease-contract.cjs';
const fail=code=>{throw new CollaborationCommandError(`COLLAB_INTEGRATION_${code}`,`Integration ${code.toLowerCase()}`,{retryable:code==='BUSY'});};
const denied=()=>({ok:false,code:'COLLAB_TASK_ACCESS_DENIED'});
const milliseconds=value=>new Date(value).getTime();
function unexpired(objects,serverTime){
  if(objects.some(object=>object.expires_at!=null&&(!Number.isFinite(milliseconds(object.expires_at))||milliseconds(object.expires_at)<=serverTime)))fail('PACKAGE_UNAVAILABLE');
}
async function clock(trx){const result=await sql`SELECT clock_timestamp() AS instant`.execute(trx);return milliseconds(result.rows[0].instant);}
const view=(row,serverTime)=>({workspaceId:row.workspace_id,headCommit:row.head_commit,revision:Number(row.revision),generation:Number(row.generation),serverTime,
  lease:row.lease_id?{id:row.lease_id,deviceId:row.lease_device_id,taskId:row.lease_task_id,deliveryId:row.lease_delivery_id,
    expiresAt:milliseconds(row.lease_expires_at),active:milliseconds(row.lease_expires_at)>serverTime}:null});

/** Server qualification only. Remote publication must check this same locked
 * generation together with head CAS; a previously returned receipt is not a
 * continuing grant. Lease traffic intentionally does not emit chat events. */
export function createIntegrationLeaseService({repository,authorize,readTask,enabled=false,commandOperations}){
  const available=()=>{if(enabled!==true)fail('PROTOCOL_UNAVAILABLE');};
  async function authorized({trx,account,input}){
    const hint=await trx.selectFrom('collaboration_tasks').selectAll().where('id','=',input.taskId).executeTakeFirst();
    if(!hint)return denied();
    const decision=await authorize(trx,account,hint.conversation_id,[hint.requester_user_id,hint.assignee_user_id]);
    if(!decision.ok)return decision;
    if(hint.requester_user_id!==account.userId||hint.shared_workspace_id!==input.workspaceId)return denied();
    // Match task creation's workspace-before-object order after the existing
    // device/conversation/member locks; no client role or lease is authority.
    const workspace=await trx.selectFrom('collaboration_shared_workspaces').selectAll().where('id','=',input.workspaceId).forUpdate().executeTakeFirst();
    if(!workspace||workspace.owner_user_id!==account.userId||workspace.conversation_id!==hint.conversation_id)return denied();
    const row=await trx.selectFrom('collaboration_tasks').selectAll().where('id','=',input.taskId).forUpdate().executeTakeFirst();
    if(!row||['conversation_id','requester_user_id','assignee_user_id','shared_workspace_id'].some(key=>row[key]!==hint[key]))return denied();
    const task=readTask(row),delivery=task.deliveries.find(value=>value.id===input.deliveryId);
    if(!task.inputGit||!delivery?.git||!['review','accepted'].includes(task.state)||task.currentDeliveryId!==input.deliveryId)return denied();
    const objects=await trx.selectFrom('stored_objects').selectAll().where('id','in',[task.inputSnapshotId,delivery.id]).orderBy('id','asc').forUpdate().execute();
    const serverTime=await clock(trx);
    for(const [id,owner] of [[task.inputSnapshotId,task.requesterUserId],[delivery.id,task.assigneeUserId]]){
      const object=objects.find(value=>value.id===id);
      if(!object||object.state!=='bound'||object.task_id!==task.id||object.conversation_id!==task.conversationId||object.purpose!=='workspace'||object.owner_user_id!==owner)fail('PACKAGE_UNAVAILABLE');
    }
    unexpired(objects,serverTime);return {ok:true,task,objects};
  }
  async function target(trx,workspaceId){return trx.selectFrom('collaboration_integration_targets').selectAll().where('workspace_id','=',workspaceId).forUpdate().executeTakeFirst();}
  function expected(row,input){if(row.head_commit!==input.expectedHead||Number(row.revision)!==input.expectedRevision)fail('HEAD_CHANGED');}
  function holding(row,input,account,serverTime){
    expected(row,input);
    if(row.lease_id!==input.leaseId||Number(row.generation)!==input.generation||row.lease_device_id!==account.deviceId
      ||row.lease_task_id!==input.taskId||row.lease_delivery_id!==input.deliveryId||!Number.isFinite(milliseconds(row.lease_expires_at))||milliseconds(row.lease_expires_at)<=serverTime)fail('FENCED');
  }
  async function mutate(action,{account,clientCommandId,...raw}){
    available();const input=contract.leaseInput(raw,action);
    return runCollaborationCommand({account,clientCommandId,input,commandType:`integration.${action}`,database:repository.database,operations:commandOperations,
      authorize:authorized,project:async({trx,account:actor,authorization})=>{
        let row=await target(trx,input.workspaceId);
        if(!row){
          if(action!=='claim')fail('FENCED');
          await trx.insertInto('collaboration_integration_targets').values({workspace_id:input.workspaceId,head_commit:authorization.task.inputGit.commit}).execute();
          row=await target(trx,input.workspaceId);
        }
        const serverTime=await clock(trx);unexpired(authorization.objects,serverTime);let patch;
        if(action==='claim'){
          expected(row,input);
          if(row.lease_id&&milliseconds(row.lease_expires_at)>serverTime)fail('BUSY');
          if(Number(row.generation)>=Number.MAX_SAFE_INTEGER-1)fail('GENERATION_LIMIT');
          patch={generation:Number(row.generation)+1,lease_id:randomUUID(),lease_device_id:actor.deviceId,lease_task_id:input.taskId,
            lease_delivery_id:input.deliveryId,lease_expires_at:new Date(serverTime+30000)};
        }else{
          holding(row,input,actor,serverTime);
          patch=action==='renew'?{lease_expires_at:new Date(serverTime+30000)}:
            {lease_id:null,lease_device_id:null,lease_task_id:null,lease_delivery_id:null,lease_expires_at:null};
        }
        patch.updated_at=new Date(serverTime);
        const updated=await trx.updateTable('collaboration_integration_targets').set(patch).where('workspace_id','=',input.workspaceId).returningAll().executeTakeFirstOrThrow();
        return {noEvent:true,event:{},project:async()=>{},response:view(updated,serverTime)};
      }});
  }
  return Object.freeze({
    async getIntegrationTarget({account,...raw}){
      available();const input=contract.leaseInput(raw,'get');
      return repository.database.transaction().execute(async trx=>{
        const decision=await authorized({trx,account,input});if(!decision.ok)throw new CollaborationCommandError(decision.code,'Integration unavailable');
        const row=await target(trx,input.workspaceId),serverTime=await clock(trx);
        unexpired(decision.objects,serverTime);
        return row?{...view(row,serverTime),initialized:true}:
          {workspaceId:input.workspaceId,headCommit:decision.task.inputGit.commit,revision:0,generation:0,serverTime,lease:null,initialized:false};
      });
    },
    claimIntegration:input=>mutate('claim',input),renewIntegration:input=>mutate('renew',input),releaseIntegration:input=>mutate('release',input),
  });
}
