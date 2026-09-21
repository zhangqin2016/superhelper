import {sql} from 'kysely';
import {createKyselyObjectRepository} from './object-repository.js';

/** Row locks serialize retirement with binding. Provider deletion is idempotent
 * and bounded; a crash before database acknowledgement simply retries it. */
export function createObjectCleanup({database,objectStore}){
  if(!database?.transaction||typeof objectStore?.delete!=='function')throw new TypeError('Object cleanup dependencies required');
  const repository=createKyselyObjectRepository(database);
  return {
    retireExpired(){return repository.withTransaction(async trx=>{
      const rows=await trx.selectFrom('stored_objects').select(['id',sql`CASE WHEN expires_at <= clock_timestamp() THEN 'object-expired' ELSE 'orphan-expired' END`.as('reason')])
        .where('state','in',['initiated','uploading','uploaded','verified','bound'])
        .where(sql`expires_at <= clock_timestamp() OR (state <> 'bound' AND bound_message_id IS NULL AND task_id IS NULL AND shared_workspace_id IS NULL AND orphan_expires_at <= clock_timestamp())`)
        .orderBy('orphan_expires_at').orderBy('id').limit(64).forUpdate().skipLocked().execute();
      for(const row of rows){
        await trx.updateTable('stored_objects').set({state:'expired',updated_at:sql`clock_timestamp()`}).where('id','=',row.id).execute();
        await repository.queueCleanup(trx,row.id,row.reason);
      }
      return rows.length;
    });},
    deleteNext(){return repository.withTransaction(async trx=>{
      const object=await trx.selectFrom('stored_objects').select(['id','object_key']).where('state','in',['expired','aborted','rejected','revoked','deleted'])
        .where(sql`EXISTS (SELECT 1 FROM object_cleanup_jobs j WHERE j.object_id=stored_objects.id AND j.state IN ('pending','leased') AND j.available_at <= clock_timestamp())`)
        .orderBy('id').limit(1).forUpdate().skipLocked().executeTakeFirst();
      if(!object)return null;
      const job=await trx.selectFrom('object_cleanup_jobs').selectAll().where('object_id','=',object.id).forUpdate().executeTakeFirst();
      const attempts=Math.min(2147483647,Number(job.attempts)+1);
      try { await objectStore.delete({objectKey:object.object_key}); }
      catch {
        const delay=Math.min(3600,5*2**Math.min(attempts,12));
        await trx.updateTable('object_cleanup_jobs').set({state:'pending',attempts,last_error_code:'COLLAB_OBJECT_STORE_UNAVAILABLE',available_at:sql`clock_timestamp() + ${delay} * interval '1 second'`}).where('object_id','=',object.id).execute();
        return {state:'retry'};
      }
      await trx.updateTable('stored_objects').set({state:'deleted',updated_at:sql`clock_timestamp()`}).where('id','=',object.id).execute();
      await trx.updateTable('object_cleanup_jobs').set({state:'completed',attempts,last_error_code:null}).where('object_id','=',object.id).execute();
      return {state:'completed'};
    });},
  };
}

export function startObjectCleanup({cleanup,onError=()=>{},schedule=setInterval,cancel=clearInterval}){
  let pending=null,stopped=false;
  const tick=()=>{
    if(stopped||pending)return pending;
    pending=(async()=>{await cleanup.retireExpired();let retry=false;for(let i=0;i<8&&!stopped;i++){const result=await cleanup.deleteNext();if(!result)break;retry ||= result.state==='retry';}if(retry)onError('COLLAB_OBJECT_CLEANUP_RETRY');})()
      .catch(()=>onError('COLLAB_OBJECT_CLEANUP_FAILED')).finally(()=>{pending=null;});
    return pending;
  };
  const timer=schedule(tick,10000);timer.unref?.();
  return {tick,async stop(){stopped=true;cancel(timer);await pending;}};
}
