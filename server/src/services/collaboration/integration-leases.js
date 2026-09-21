import {randomUUID} from 'node:crypto';
import {sql} from 'kysely';
import {runCollaborationCommand} from './command-runner.js';
import {CollaborationCommandError,canonicalRequestJson} from './idempotency.js';
import contract from './integration-lease-contract.cjs';
import publicationContract from './shared-publication-contract.cjs';
import gitContract from './task-git-descriptor.cjs';
import {authorizeCollaborationAction} from './authorization.js';
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

/** Qualification and publication share one locked generation/head. Historical
 * lease receipts are never continuing grants. Packs remain encrypted; clients
 * must verify Git structure and exact validation evidence before publishing. */
export function createIntegrationLeaseService({repository,authorize,readTask,crypto,enabled=false,commandOperations}){
  const available=()=>{if(enabled!==true)fail('PROTOCOL_UNAVAILABLE');};
  async function ownerWorkspace(trx,account,workspaceId){
    const deny=()=>{throw new CollaborationCommandError('COLLAB_TASK_ACCESS_DENIED','Workspace unavailable');};
    const hint=await trx.selectFrom('collaboration_shared_workspaces').selectAll().where('id','=',workspaceId).executeTakeFirst();
    if(!hint||hint.owner_user_id!==account.userId)return deny();
    if(!(await repository.lockDevice(trx,account)).ok)return deny();
    const context=await repository.lockConversationContext(trx,{actorUserId:account.userId,conversationId:hint.conversation_id});
    if(context.decision||!authorizeCollaborationAction(context,'read').ok)return deny();
    const workspace=await trx.selectFrom('collaboration_shared_workspaces').selectAll().where('id','=',workspaceId).forUpdate().executeTakeFirst();
    if(!workspace||workspace.owner_user_id!==account.userId||workspace.conversation_id!==hint.conversation_id)return deny();
    return workspace;
  }
  // The workspace retains authority over its exact original input object. The
  // object keeps one task binding; retirement still invalidates every download.
  async function baseline(trx,workspaceId,ownerUserId,conversationId){
    const row=await trx.selectFrom('collaboration_shared_baselines').selectAll().where('workspace_id','=',workspaceId).executeTakeFirst();
    if(!row)return null;
    if(row.owner_user_id!==ownerUserId||row.conversation_id!==conversationId)fail('BASELINE_UNAVAILABLE');
    const value=JSON.parse(crypto.decryptIntegrationBaseline({ciphertext:row.content_ciphertext,keyVersion:row.content_key_version,
      messageId:workspaceId,conversationId}).toString('utf8'));
    if(value.workspaceId!==workspaceId||value.ownerUserId!==ownerUserId||value.conversationId!==conversationId
      ||value.sourceTaskId!==row.source_task_id||value.objectId!==row.source_object_id||value.git?.commit!==row.commit_id)fail('BASELINE_UNAVAILABLE');
    const git=gitContract.gitDescriptor(value.git);
    if(git.prerequisites.length||!git.ref.endsWith('/baseline'))fail('BASELINE_UNAVAILABLE');
    const source=await trx.selectFrom('collaboration_tasks').selectAll().where('id','=',row.source_task_id).forUpdate().executeTakeFirst();
    if(!source||source.shared_workspace_id!==workspaceId||source.requester_user_id!==ownerUserId||source.conversation_id!==conversationId
      ||source.input_snapshot_id!==value.objectId||canonicalRequestJson(readTask(source).inputGit)!==canonicalRequestJson(git))fail('BASELINE_UNAVAILABLE');
    const object=await trx.selectFrom('stored_objects').selectAll().where('id','=',value.objectId).forUpdate().executeTakeFirst();
    if(!object||object.state!=='bound'||object.task_id!==source.id||object.shared_workspace_id||object.bound_message_id
      ||object.owner_user_id!==ownerUserId||object.conversation_id!==conversationId||object.purpose!=='workspace')fail('PACKAGE_UNAVAILABLE');
    unexpired([object],await clock(trx));return value;
  }
  async function anchor(trx,task,head){
    const existing=await baseline(trx,task.sharedWorkspaceId,task.requesterUserId,task.conversationId);
    if(existing){if(existing.git.commit!==head)fail('BASELINE_UNAVAILABLE');return;}
    if(task.inputGit.commit!==head)fail('BASELINE_UNAVAILABLE');
    const value={workspaceId:task.sharedWorkspaceId,conversationId:task.conversationId,ownerUserId:task.requesterUserId,
      sourceTaskId:task.id,objectId:task.inputSnapshotId,git:task.inputGit};
    const envelope=crypto.encryptIntegrationBaseline({plaintext:Buffer.from(JSON.stringify(value)),messageId:value.workspaceId,conversationId:value.conversationId});
    await trx.insertInto('collaboration_shared_baselines').values({workspace_id:value.workspaceId,conversation_id:value.conversationId,owner_user_id:value.ownerUserId,
      source_task_id:value.sourceTaskId,source_object_id:value.objectId,commit_id:head,content_ciphertext:envelope.ciphertext,content_key_version:envelope.keyVersion}).execute();
  }
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
    unexpired(objects,serverTime);
    const current=await target(trx,input.workspaceId);
    if(current&&Number(current.revision)===0){
      const initial=await baseline(trx,input.workspaceId,account.userId,task.conversationId);
      if(initial&&initial.git.commit!==current.head_commit)fail('BASELINE_UNAVAILABLE');
    }
    return {ok:true,task,objects};
  }
  async function target(trx,workspaceId){return trx.selectFrom('collaboration_integration_targets').selectAll().where('workspace_id','=',workspaceId).forUpdate().executeTakeFirst();}
  function expected(row,input){if(row.head_commit!==input.expectedHead||Number(row.revision)!==input.expectedRevision)fail('HEAD_CHANGED');}
  function holding(row,input,account,serverTime){
    if(!row)fail('FENCED');
    expected(row,input);
    if(row.lease_id!==input.leaseId||Number(row.generation)!==input.generation||row.lease_device_id!==account.deviceId
      ||row.lease_task_id!==input.taskId||row.lease_delivery_id!==input.deliveryId||!Number.isFinite(milliseconds(row.lease_expires_at))||milliseconds(row.lease_expires_at)<=serverTime)fail('FENCED');
  }
  function durable(input){const {leaseId,generation,...content}=input;return content;}
  function readPublication(row){
    if(!row)fail('PUBLICATION_UNAVAILABLE');
    const value=JSON.parse(crypto.decryptIntegrationPublication({ciphertext:row.content_ciphertext,keyVersion:row.content_key_version,
      messageId:row.id,conversationId:row.conversation_id}).toString('utf8'));
    if(value.id!==row.id||value.workspaceId!==row.workspace_id||value.conversationId!==row.conversation_id||value.ownerUserId!==row.owner_user_id
      ||value.taskId!==row.task_id||value.deliveryId!==row.delivery_id||value.objectId!==row.object_id||value.git?.commit!==row.commit_id
      ||value.expectedRevision+1!==Number(row.revision)||value.revision!==Number(row.revision))fail('PUBLICATION_UNAVAILABLE');
    return value;
  }
  async function publicationChain(trx,id,workspaceId,ownerUserId,conversationId){
    const chain=[],seen=new Set();let child=null;
    while(id){
      if(seen.has(id)||chain.length>=64)fail('FULL_PACK_REQUIRED');seen.add(id);
      const row=await trx.selectFrom('collaboration_shared_publications').selectAll().where('id','=',id).executeTakeFirst();
      if(!row||row.workspace_id!==workspaceId||row.owner_user_id!==ownerUserId||row.conversation_id!==conversationId)fail('PUBLICATION_UNAVAILABLE');
      const publication=readPublication(row);
      if(child&&(child.expectedHead!==publication.git.commit||child.expectedRevision!==publication.revision))fail('PUBLICATION_UNAVAILABLE');
      if(Boolean(publication.parentPublicationId)!==Boolean(publication.git.prerequisites.length))fail('PUBLICATION_UNAVAILABLE');
      const object=await trx.selectFrom('stored_objects').selectAll().where('id','=',publication.objectId).forUpdate().executeTakeFirst();
      if(!object||object.state!=='bound'||object.shared_workspace_id!==workspaceId||object.owner_user_id!==ownerUserId
        ||object.conversation_id!==conversationId||object.purpose!=='workspace'||object.task_id||object.bound_message_id)fail('PACKAGE_UNAVAILABLE');
      chain.push({publication,object});child=publication;id=publication.parentPublicationId;
    }
    unexpired(chain.map(entry=>entry.object),await clock(trx));
    return chain;
  }
  async function authorizePublication(args){
    const decision=await authorized(args);if(!decision.ok)return decision;
    const {trx,input,account}=args;
    const prior=await trx.selectFrom('collaboration_shared_publications').selectAll().where('id','=',input.publicationId).executeTakeFirst();
    if(prior){
      const chain=await publicationChain(trx,prior.id,input.workspaceId,account.userId,decision.task.conversationId);
      return {...decision,prior:chain[0].publication};
    }
    // Reject a foreign binding before acquiring an object lock in this workspace.
    const matches=object=>object&&object.state==='verified'&&!object.task_id&&!object.bound_message_id&&!object.shared_workspace_id
      &&object.owner_user_id===account.userId&&object.conversation_id===decision.task.conversationId&&object.purpose==='workspace'
      &&/^[a-f0-9]{64}$/.test(object.ciphertext_sha256||'');
    const hint=await trx.selectFrom('stored_objects').selectAll().where('id','=',input.objectId).executeTakeFirst();
    if(!matches(hint))fail('PACKAGE_UNAVAILABLE');
    const object=await trx.selectFrom('stored_objects').selectAll().where('id','=',input.objectId).forUpdate().executeTakeFirst();
    if(!matches(object))fail('PACKAGE_UNAVAILABLE');
    const serverTime=await clock(trx);unexpired([object,{expires_at:object.orphan_expires_at}],serverTime);
    return {...decision,object};
  }
  const publicationReceipt=value=>({workspaceId:value.workspaceId,publicationId:value.id,headCommit:value.git.commit,revision:value.revision});
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
          if(Number(row.revision)===0)await anchor(trx,authorization.task,row.head_commit);
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
    async resolveIntegrationBaseline({account,clientCommandId,...raw}){
      available();const input=contract.leaseInput(raw,'resolve');
      return runCollaborationCommand({account,clientCommandId,input,commandType:'integration.resolveBaseline',database:repository.database,operations:commandOperations,
        authorize:async args=>{
          const decision=await authorized(args);if(!decision.ok)return decision;
          const row=await target(args.trx,input.workspaceId);if(!row)fail('HEAD_CHANGED');expected(row,input);
          return decision;
        },project:async({trx,authorization})=>{
          const task=authorization.task;
          const response=ready=>({noEvent:true,event:{},project:async()=>{},response:{workspaceId:input.workspaceId,headCommit:input.expectedHead,ready,nextCursor:null}});
          if(await baseline(trx,input.workspaceId,account.userId,task.conversationId))return response(true);
          // Indexed keyset pages bound decryption work even for a long-lived
          // workspace. Source task state/old assignee membership are irrelevant.
          let query=trx.selectFrom('collaboration_tasks').selectAll().where('shared_workspace_id','=',input.workspaceId)
            .where('requester_user_id','=',account.userId).where('conversation_id','=',task.conversationId);
          if(input.afterTaskId)query=query.where('id','>',input.afterTaskId);
          const rows=await query.orderBy('id','asc').limit(64).execute();
          for(const row of rows){
            const source=readTask(row);if(source.inputGit?.commit!==input.expectedHead)continue;
            const git=gitContract.gitDescriptor(source.inputGit);if(git.prerequisites.length||!git.ref.endsWith('/baseline'))continue;
            const object=await trx.selectFrom('stored_objects').selectAll().where('id','=',source.inputSnapshotId).forUpdate().executeTakeFirst();
            if(!object||object.state!=='bound'||object.task_id!==source.id||object.shared_workspace_id||object.bound_message_id
              ||object.owner_user_id!==account.userId||object.conversation_id!==task.conversationId||object.purpose!=='workspace')continue;
            try{unexpired([object],await clock(trx));}catch(error){if(error.code==='COLLAB_INTEGRATION_PACKAGE_UNAVAILABLE')continue;throw error;}
            await anchor(trx,source,input.expectedHead);return response(true);
          }
          const result=response(false);result.response.nextCursor=rows.length===64?rows.at(-1).id:null;return result;
        }});
    },
    async getIntegrationBaseline({account,workspaceId}){
      available();if(typeof workspaceId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(workspaceId))fail('INVALID');
      return repository.database.transaction().execute(async trx=>{
        await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
        await sql`SET LOCAL statement_timeout = '8s'`.execute(trx);
        const workspace=await ownerWorkspace(trx,account,workspaceId);
        const value=await baseline(trx,workspaceId,account.userId,workspace.conversation_id);
        if(!value)fail('BASELINE_UNAVAILABLE');
        return {workspaceId,baseline:value};
      });
    },
    async publishIntegration({account,clientCommandId,...raw}){
      available();const input=publicationContract.publicationInput(raw);
      return runCollaborationCommand({account,clientCommandId,input,commandType:'integration.publish',database:repository.database,operations:commandOperations,
        authorize:authorizePublication,project:async({trx,account:actor,authorization})=>{
          if(authorization.prior){
            const {id,conversationId,ownerUserId,revision,parentPublicationId,...prior}=authorization.prior;
            if(canonicalRequestJson(prior)!==canonicalRequestJson(durable(input)))fail('PUBLICATION_CONFLICT');
            return {noEvent:true,event:{},project:async()=>{},response:publicationReceipt(authorization.prior)};
          }
          const row=await target(trx,input.workspaceId);holding(row,input,actor,await clock(trx));
          const task=authorization.task,delivery=task.deliveries.find(value=>value.id===input.deliveryId);
          if(task.inputGit.commit!==input.baselineCommit||delivery.git.commit!==input.deliveryCommit)fail('SOURCE_CHANGED');
          if(Number(row.revision)>=Number.MAX_SAFE_INTEGER-1)fail('REVISION_LIMIT');
          const parentPublicationId=input.git.prerequisites.length?row.head_publication_id:null;
          if(input.git.prerequisites.length&&!parentPublicationId)fail('FULL_PACK_REQUIRED');
          let parentObjects=[];
          if(parentPublicationId){
            const chain=await publicationChain(trx,parentPublicationId,input.workspaceId,actor.userId,task.conversationId);
            if(chain.length>=64)fail('FULL_PACK_REQUIRED');
            if(chain[0].publication.git.commit!==row.head_commit||chain[0].publication.revision!==Number(row.revision))fail('PUBLICATION_UNAVAILABLE');
            parentObjects=chain.map(entry=>entry.object);
          }
          const publication={...durable(input),id:input.publicationId,conversationId:task.conversationId,ownerUserId:actor.userId,
            revision:input.expectedRevision+1,parentPublicationId};
          const envelope=crypto.encryptIntegrationPublication({plaintext:Buffer.from(JSON.stringify(publication)),messageId:publication.id,conversationId:publication.conversationId});
          return {event:{id:`evt_${randomUUID()}`,conversationId:null,type:'workspace.published',payload:publicationReceipt(publication)},
            recipientUserIds:[actor.userId],response:publicationReceipt(publication),project:async()=>{
              const serverTime=await clock(trx);holding(row,input,actor,serverTime);
              const requiredObjects=[...authorization.objects,...parentObjects,authorization.object];
              unexpired([...requiredObjects,{expires_at:authorization.object.orphan_expires_at}],serverTime);
              await trx.updateTable('stored_objects').set({state:'bound',shared_workspace_id:input.workspaceId,updated_at:new Date(serverTime)}).where('id','=',input.objectId).execute();
              await trx.insertInto('collaboration_shared_publications').values({id:publication.id,workspace_id:input.workspaceId,conversation_id:task.conversationId,
                owner_user_id:actor.userId,task_id:input.taskId,delivery_id:input.deliveryId,object_id:input.objectId,commit_id:input.git.commit,revision:publication.revision,
                content_ciphertext:envelope.ciphertext,content_key_version:envelope.keyVersion}).execute();
              const updated=await trx.updateTable('collaboration_integration_targets').set({head_commit:input.git.commit,revision:publication.revision,
                head_publication_id:publication.id,lease_id:null,lease_device_id:null,lease_task_id:null,lease_delivery_id:null,lease_expires_at:null,updated_at:new Date(serverTime)})
                .where('workspace_id','=',input.workspaceId).where('head_commit','=',input.expectedHead).where('revision','=',input.expectedRevision)
                .where('generation','=',input.generation).where('lease_id','=',input.leaseId).where('lease_expires_at','>',sql`clock_timestamp()`)
                .where(sql`NOT EXISTS (SELECT 1 FROM stored_objects WHERE id = ANY(${requiredObjects.map(object=>object.id)}::text[])
                  AND (expires_at <= clock_timestamp() OR (id = ${input.objectId} AND orphan_expires_at <= clock_timestamp())))`).executeTakeFirst();
              if(Number(updated.numUpdatedRows)!==1)fail('FENCED');
            }};
        }});
    },
    async getIntegrationPublication({account,workspaceId,publicationId}){
      available();
      if(![workspaceId,...(publicationId===undefined?[]:[publicationId])].every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value)))fail('INVALID');
      return repository.database.transaction().execute(async trx=>{
        await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
        await sql`SET LOCAL statement_timeout = '8s'`.execute(trx);
        const workspace=await ownerWorkspace(trx,account,workspaceId);
        const row=await target(trx,workspaceId),id=publicationId??row?.head_publication_id;
        if(!id)return {workspaceId,publication:null};
        const chain=await publicationChain(trx,id,workspaceId,account.userId,workspace.conversation_id),publication=chain[0].publication;
        if(publicationId===undefined&&(publication.git.commit!==row.head_commit||publication.revision!==Number(row.revision)))fail('PUBLICATION_UNAVAILABLE');
        return {workspaceId,publication};
      });
    },
    async getIntegrationTarget({account,...raw}){
      available();const input=contract.leaseInput(raw,'get');
      return repository.database.transaction().execute(async trx=>{
        await sql`SET LOCAL lock_timeout = '2s'`.execute(trx);
        await sql`SET LOCAL statement_timeout = '8s'`.execute(trx);
        const decision=await authorized({trx,account,input});if(!decision.ok)throw new CollaborationCommandError(decision.code,'Integration unavailable');
        const row=await target(trx,input.workspaceId),serverTime=await clock(trx);
        unexpired(decision.objects,serverTime);
        const baselineReady=row&&Number(row.revision)===0?Boolean(await baseline(trx,input.workspaceId,account.userId,decision.task.conversationId)):false;
        return row?{...view(row,serverTime),initialized:true,baselineReady}:
          {workspaceId:input.workspaceId,headCommit:decision.task.inputGit.commit,revision:0,generation:0,serverTime,lease:null,initialized:false,baselineReady:false};
      });
    },
    claimIntegration:input=>mutate('claim',input),renewIntegration:input=>mutate('renew',input),releaseIntegration:input=>mutate('release',input),
  });
}
