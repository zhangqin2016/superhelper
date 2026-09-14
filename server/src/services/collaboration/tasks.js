import { randomUUID } from 'node:crypto';
import { runCollaborationCommand } from './command-runner.js';
import { authorizeCollaborationAction } from './authorization.js';
import { CollaborationCommandError } from './idempotency.js';
import contract from './task-contract.cjs';
import { createIntegrationLeaseService } from './integration-leases.js';

const denied = () => ({ ok: false, code: 'COLLAB_TASK_ACCESS_DENIED' });
const unavailable = () => { throw new CollaborationCommandError('COLLAB_TASK_UNAVAILABLE', 'Task unavailable'); };
const inaccessible = () => { throw new CollaborationCommandError('COLLAB_TASK_ACCESS_DENIED', 'Task unavailable'); };

/** Not registered until task-scoped package authorization and desktop recovery
 * are available. Neither conversation object access nor client booleans can
 * stand in for the required package broker. */
export function createCollaborationTaskService({ repository, crypto, packages, now = Date.now, createId = () => `task_${randomUUID()}`, commandOperations, integrationLeasesEnabled=false }) {
  if (!repository?.database || !crypto?.encryptTask || !crypto?.decryptTask || !packages?.verifyInput || !packages?.verifyDelivery) throw new TypeError('Task repository, encryption and scoped package broker required');
  const read = (row) => {
    if (!row) return unavailable();
    const task = JSON.parse(crypto.decryptTask({ ciphertext: row.content_ciphertext, keyVersion: row.content_key_version,
      messageId: row.id, conversationId: row.conversation_id, revision: Number(row.revision) }).toString('utf8'));
    if (task.id !== row.id || task.conversationId !== row.conversation_id || task.revision !== Number(row.revision) || task.inputSnapshotId !== row.input_snapshot_id
      || task.requesterUserId !== row.requester_user_id || task.assigneeUserId !== row.assignee_user_id || task.state !== row.state
      || (task.sharedWorkspaceId ?? null) !== (row.shared_workspace_id ?? null)) return unavailable();
    return task;
  };
  const encryptedRow = (task) => {
    const envelope = crypto.encryptTask({ plaintext: Buffer.from(JSON.stringify(task)), messageId: task.id, conversationId: task.conversationId, revision: task.revision });
    return { id: task.id, conversation_id: task.conversationId, requester_user_id: task.requesterUserId,
      assignee_user_id: task.assigneeUserId, input_snapshot_id: task.inputSnapshotId, state: task.state, revision: task.revision,
      ...(task.sharedWorkspaceId ? {shared_workspace_id:task.sharedWorkspaceId} : {}),
      content_ciphertext: envelope.ciphertext, content_key_version: envelope.keyVersion, updated_at: new Date(task.updatedAt) };
  };
  async function authorize(trx, account, conversationId, parties) {
    const device = await repository.lockDevice(trx, account);
    if (!device.ok) return device;
    const context = await repository.lockConversationContext(trx, {actorUserId:account.userId, conversationId});
    if (context.decision) return context.decision;
    const access = authorizeCollaborationAction(context, 'send');
    if (!access.ok || !parties.includes(account.userId)) return denied();
    const members = await repository.activeConversationMemberIds(trx, conversationId);
    if (!parties.every((id) => members.includes(id))) return denied();
    return {ok:true, authorizedParticipantIds:parties};
  }
  const projection = (task, priorRevision = null) => ({
    // Relationship sequence rather than conversation sequence: group members
    // not assigned to this task receive no metadata or task-specific events.
    event:{id:`evt_${randomUUID()}`,conversationId:null,type:'task.updated',payload:{taskId:task.id,revision:task.revision,state:task.state}},
    recipientUserIds:[task.requesterUserId,task.assigneeUserId].sort(),
    response:{taskId:task.id,revision:task.revision,state:task.state},
    project:async({trx})=>{
      const row=encryptedRow(task);
      if(priorRevision==null) await trx.insertInto('collaboration_tasks').values({...row,created_at:new Date(task.createdAt)}).execute();
      else {
        const result=await trx.updateTable('collaboration_tasks').set(row).where('id','=',task.id).where('revision','=',priorRevision).executeTakeFirst();
        if(Number(result.numUpdatedRows)!==1) throw new CollaborationCommandError('COLLAB_TASK_REVISION_CONFLICT','Task changed');
      }
      const delivery=task.state==='review'?task.deliveries.at(-1):null;
      if(delivery) await trx.insertInto('collaboration_task_deliveries').values({id:delivery.id,task_id:task.id,input_snapshot_id:task.inputSnapshotId,
        manifest_hash:delivery.manifestHash,submitted_by:task.assigneeUserId,task_revision:task.revision}).execute();
    },
  });
  return Object.freeze({
    ...createIntegrationLeaseService({repository,authorize,readTask:read,enabled:integrationLeasesEnabled,commandOperations}),
    async get({account,taskId}) {
      return repository.database.transaction().execute(async trx=>{
        const hint=await trx.selectFrom('collaboration_tasks').selectAll().where('id','=',taskId).executeTakeFirst();
        if(!hint)return inaccessible();
        const decision=await authorize(trx,account,hint.conversation_id,[hint.requester_user_id,hint.assignee_user_id]);
        if(!decision.ok)return inaccessible();
        const locked=await trx.selectFrom('collaboration_tasks').selectAll().where('id','=',taskId).forUpdate().executeTakeFirst();
        if(!locked || locked.conversation_id!==hint.conversation_id || locked.requester_user_id!==hint.requester_user_id || locked.assignee_user_id!==hint.assignee_user_id)return inaccessible();
        return read(locked);
      });
    },
    async list({account,conversationId}) {
      // IDs are merely candidates; every returned body is freshly authorized.
      // A revoked task disappearing from a listing is not a global list error.
      const rows=await repository.database.selectFrom('collaboration_tasks').select('id')
        .where('conversation_id','=',conversationId)
        .where(eb=>eb.or([eb('requester_user_id','=',account.userId),eb('assignee_user_id','=',account.userId)]))
        .orderBy('updated_at','desc').orderBy('id','desc').limit(50).execute();
      const tasks=[];
      for(const row of rows){try{tasks.push(await this.get({account,taskId:row.id}));}catch(error){if(!['COLLAB_TASK_UNAVAILABLE','COLLAB_TASK_ACCESS_DENIED'].includes(error.code))throw error;}}
      return tasks;
    },
    async listHistory({account,conversationId,cursor}) {
      const rows=await repository.database.transaction().execute(async trx=>{
        const decision=await authorize(trx,account,conversationId,[account.userId]);
        if(!decision.ok)return inaccessible();
        let query=trx.selectFrom('collaboration_tasks').select(['id','created_at'])
          .where('conversation_id','=',conversationId)
          .where(eb=>eb.or([eb('requester_user_id','=',account.userId),eb('assignee_user_id','=',account.userId)]));
        // Creation order is immutable; progress updates cannot move a task
        // across a page boundary. The ID breaks timestamp ties deterministically.
        if(cursor)query=query.where(eb=>eb.or([eb('created_at','<',new Date(cursor.createdAt)),
          eb.and([eb('created_at','=',new Date(cursor.createdAt)),eb('id','<',cursor.id)])]));
        return query.orderBy('created_at','desc').orderBy('id','desc').limit(51).execute();
      });
      const candidates=rows.slice(0,50),tasks=[];
      for(const row of candidates) {
        try {tasks.push(await this.get({account,taskId:row.id}));}
        catch(error){if(error.code!=='COLLAB_TASK_ACCESS_DENIED')throw error;}
      }
      const last=candidates.at(-1);
      return {tasks,nextCursor:rows.length>50?{createdAt:new Date(last.created_at).getTime(),id:last.id}:null};
    },
    async missingGitObjects({account,taskId,deliveryId,haveCommits}) {
      if (!Array.isArray(haveCommits) || haveCommits.length>256 || new Set(haveCommits).size!==haveCommits.length
        || haveCommits.some(commit=>typeof commit!=='string' || !/^[0-9a-f]{40}$/.test(commit)))
        throw new CollaborationCommandError('COLLAB_TASK_INVALID','Invalid task request');
      // The hashes only suppress this authorized task's required packs. Never
      // query a global hash index or reveal whether another task owns a hash.
      const task=await this.get({account,taskId});
      if(['cancelled','declined'].includes(task.state))return inaccessible();
      if(!task.inputGit)throw new CollaborationCommandError('COLLAB_TASK_PROTOCOL_UNAVAILABLE','Git task required');
      const objects=[{objectId:task.inputSnapshotId,descriptor:task.inputGit}];
      if(deliveryId!==undefined){
        const delivery=task.deliveries.find(item=>item.id===deliveryId);
        if(!delivery?.git)return inaccessible();
        objects.push({objectId:delivery.id,descriptor:delivery.git});
      }
      // Cached commits suppress bytes, never the current package authorization.
      const stored=await repository.database.selectFrom('stored_objects')
        .select(['id','state','task_id','conversation_id','purpose','owner_user_id','expires_at'])
        .where('id','in',objects.map(item=>item.objectId)).execute();
      for(const item of objects){
        const object=stored.find(row=>row.id===item.objectId);
        const owner=item.objectId===task.inputSnapshotId?task.requesterUserId:task.assigneeUserId;
        if(!object || object.state!=='bound' || object.task_id!==task.id || object.conversation_id!==task.conversationId
          || object.purpose!=='workspace' || object.owner_user_id!==owner
          || (object.expires_at!=null && (!Number.isFinite(new Date(object.expires_at).getTime()) || new Date(object.expires_at).getTime()<=now())))
          throw new CollaborationCommandError('COLLAB_TASK_PACKAGE_UNAVAILABLE','Task package unavailable');
      }
      return {objects:objects.filter(item=>!haveCommits.includes(item.descriptor.commit))};
    },
    async create({account,clientCommandId,...input}) {
      // ID generated inside project: same-intent receipt replay cannot fail
      // because a retry picked a different task identifier.
      return runCollaborationCommand({account,clientCommandId,input,commandType:'task.create',database:repository.database,operations:commandOperations,
        authorize:async({trx,account:actor})=>{
          const decision=await authorize(trx,actor,input.conversationId,[actor.userId,input.assigneeUserId]);
          if (!decision.ok || !input.sharedWorkspaceId) return decision;
          const workspace=await trx.selectFrom('collaboration_shared_workspaces').selectAll().where('id','=',input.sharedWorkspaceId).forUpdate().executeTakeFirst();
          if (workspace && (workspace.owner_user_id!==actor.userId || workspace.conversation_id!==input.conversationId)) return denied();
          return decision;
        },
        project:async({trx,account:actor,authorization})=>{
          const task=contract.createTask({...input,id:createId()},{actorUserId:actor.userId,authorizedParticipantIds:authorization.authorizedParticipantIds,now:now()});
          if (task.sharedWorkspaceId) {
            // Concurrent first creates can meet at the unique key. Recheck the
            // actual winner before binding any object or task to this identity.
            await trx.insertInto('collaboration_shared_workspaces').values({id:task.sharedWorkspaceId,
              conversation_id:task.conversationId,owner_user_id:actor.userId})
              .onConflict(oc=>oc.column('id').doNothing()).execute();
            const workspace=await trx.selectFrom('collaboration_shared_workspaces').selectAll().where('id','=',task.sharedWorkspaceId).forUpdate().executeTakeFirst();
            if (!workspace || workspace.owner_user_id!==actor.userId || workspace.conversation_id!==task.conversationId)
              throw new CollaborationCommandError('COLLAB_TASK_ACCESS_DENIED','Workspace unavailable');
          }
          // Broker binds the verified input to this task in the same transaction.
          await packages.verifyInput({trx,task,account:actor});
          return projection(task);
        }});
    },
    async act({account,clientCommandId,taskId,...command}) {
      return runCollaborationCommand({account,clientCommandId,input:{taskId,...command},commandType:'task.change',database:repository.database,operations:commandOperations,
        authorize:async({trx,account:actor})=>{
          const hint=await trx.selectFrom('collaboration_tasks').selectAll().where('id','=',taskId).executeTakeFirst();
          if(!hint) return denied();
          const decision=await authorize(trx,actor,hint.conversation_id,[hint.requester_user_id,hint.assignee_user_id]);
          if(!decision.ok)return decision;
          const locked=await trx.selectFrom('collaboration_tasks').selectAll().where('id','=',taskId).forUpdate().executeTakeFirst();
          if(!locked || locked.conversation_id!==hint.conversation_id || locked.requester_user_id!==hint.requester_user_id || locked.assignee_user_id!==hint.assignee_user_id)return denied();
          return {...decision,task:read(locked)};
        },
        project:async({trx,account:actor,authorization})=>{
          const task=authorization.task;
          const verifiedDelivery=command.action==='submit'?await packages.verifyDelivery({trx,account:actor,task,deliveryId:command.deliveryId}):undefined;
          const next=contract.transitionTask(task,command,{actorUserId:actor.userId,authorizedParticipantIds:authorization.authorizedParticipantIds,now:now(),verifiedDelivery});
          return projection(next,task.revision);
        }});
    },
  });
}
