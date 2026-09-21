"use strict";
const {createTaskRecords}=require('./task-records');
const fail=code=>Object.assign(Error(code),{code});
const identity=value=>JSON.stringify([value.id,value.accountId,value.scopeId,value.conversationId,value.direction,value.purpose,value.commandIds,value.checkpoint.deviceId]);
// Main-only snapshots contain encryption keys. Task records encrypt them under
// current account/scope authority; they are never renderer views or capabilities.
function createTaskTransferJournal({store,deviceId,assertActive}){
  const records=createTaskRecords({store,assertActive});
  const key=id=>`transfer-journal:${id}`;
  function check(value){
    assertActive();
    if(value?.accountId!==store.accountId||value.direction!=='upload'||value.purpose!=='workspace'||value.checkpoint?.taskOwned!==true)throw fail('COLLAB_TRANSFER_MANIFEST_INVALID');
    if(value.checkpoint.deviceId!==deviceId)throw fail('COLLAB_TRANSFER_DEVICE_CHANGED');
  }
  function get(id){
    const row=records.get(key(id));if(!row)return null;
    if(row.kind!=='task-transfer-journal'||row.snapshot?.id!==id)throw fail('COLLAB_TRANSFER_MANIFEST_INVALID');
    check(row.snapshot);return row;
  }
  return {
    get,
    commit(snapshot){
      if(snapshot.checkpoint?.taskOwned!==true||snapshot.direction!=='upload')return;
      check(snapshot);
      store.db.transaction(()=>{
        const prior=get(snapshot.id);
        if(prior&&(prior.deleted||identity(prior.snapshot)!==identity(snapshot)))throw fail('COLLAB_TRANSFER_CONFLICT');
        if(prior?.snapshot.revision===snapshot.revision){
          if(JSON.stringify(prior.snapshot)!==JSON.stringify(snapshot))throw fail('COLLAB_TRANSFER_CONFLICT');return;
        }
        if(prior&&prior.snapshot.revision!==snapshot.revision-1)throw fail('COLLAB_TRANSFER_CONFLICT');
        records.put(key(snapshot.id),{kind:'task-transfer-journal',conversationId:snapshot.conversationId,snapshot,deleted:false});
      })();
    },
    remove(id){store.db.transaction(()=>{const prior=get(id);if(prior)records.put(key(id),{...prior,deleted:true,snapshot:{...prior.snapshot,checkpoint:{taskOwned:true,deviceId,state:'cancelled'}}});})();},
  };
}
module.exports={createTaskTransferJournal};
