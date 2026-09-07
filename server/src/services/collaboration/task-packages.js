import { CollaborationCommandError } from './idempotency.js';
const fail=()=>{throw new CollaborationCommandError('COLLAB_TASK_PACKAGE_UNAVAILABLE','Task package unavailable');};

/** The existing upload pipeline proves ciphertext integrity. This broker
 * binds a sealed workspace object to exactly one task, never to a message.
 * The receiving client additionally validates the package manifest/paths. */
export function createTaskPackageBroker({now=Date.now}={}){
  async function bind({trx,task,account,objectId}){
    const object=await trx.selectFrom('stored_objects').selectAll().where('id','=',objectId).forUpdate().executeTakeFirst();
    if(!object || object.state!=='verified' || object.task_id || object.bound_message_id || object.owner_user_id!==account.userId
      || object.conversation_id!==task.conversationId || object.purpose!=='workspace'
      || !/^[a-f0-9]{64}$/.test(object.ciphertext_sha256||''))return fail();
    for(const expires of [object.expires_at,object.orphan_expires_at])if(expires!=null && (!Number.isFinite(new Date(expires).getTime()) || new Date(expires).getTime()<=now()))return fail();
    await trx.updateTable('stored_objects').set({state:'bound',task_id:task.id,updated_at:new Date(now())}).where('id','=',objectId).execute();
    return object;
  }
  return Object.freeze({
    verifyInput:async({trx,task,account})=>bind({trx,task,account,objectId:task.inputSnapshotId}),
    verifyDelivery:async({trx,task,account,deliveryId})=>{
      const object=await bind({trx,task,account,objectId:deliveryId});
      return {id:deliveryId,taskId:task.id,inputSnapshotId:task.inputSnapshotId,actorUserId:account.userId,complete:true,manifestHash:object.ciphertext_sha256};
    },
  });
}
