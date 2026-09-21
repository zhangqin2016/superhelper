"use strict";
const {createHash}=require('node:crypto');
const {createTaskRecords}=require('./task-records');
const {createIntegrationIntents}=require('./integration-intents');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=()=>{throw Object.assign(Error('Invalid legacy publication'),{code:'COLLAB_PUBLICATION_MIGRATION_INVALID'});};

/** Local recovery scheduling only. No lease, Git change, validation approval or
 * remote acknowledgement is created by reviving an old completed intent. */
function createLegacyPublicationMigration({store,assertActive,enabled=false,now=()=>store.now()}){
  const records=createTaskRecords({store,assertActive}),intents=createIntegrationIntents({store,assertActive,now});
  let cursor='',done=false,running=null;
  async function scan(){
    assertActive();if(enabled!==true||done)return;
    const rows=store.db.all("SELECT * FROM task_integration_work WHERE account_id=? AND state='done' AND intent_id>? ORDER BY intent_id LIMIT 8",store.accountId,cursor);
    for(const row of rows){
      try{store.db.transaction(()=>{
        assertActive();
        const current=store.db.get('SELECT * FROM task_integration_work WHERE account_id=? AND intent_id=?',store.accountId,row.intent_id);
        if(current?.state!=='done'||current.generation!==row.generation)return;
        const intent=intents.get(row.intent_id);if(intent?.state!=='completed'||intent.input.chain!=='shared')return;
        const journal=records.get(`shared-publication:${hash(intent.id)}`);if(!journal||journal.remoteReceipt)return;
        if(typeof journal.outboxId!=='string')fail();
        const outbox=records.get(journal.outboxId),candidate=journal.candidate,input=intent.input;
        if(journal.kind!=='shared-publication'||journal.intentId!==intent.id||journal.state!=='published'
          ||!candidate||candidate.state!=='ready'||candidate.headRef!==`refs/workspaces/${hash(input.workspaceId)}/head`||candidate.baseline!==input.baselineCommit||candidate.delivery!==input.deliveryCommit
          ||journal.publication?.commit!==candidate.commit||journal.validation?.commit!==candidate.commit||journal.validation.ok!==true
          ||outbox?.kind!=='publication-outbox'||outbox.intentId!==intent.id||outbox.state!=='queued'
          ||outbox.content?.commit!==candidate.commit||outbox.content.expectedHead!==candidate.head||outbox.content.tree!==candidate.tree
          ||outbox.content.workspaceId!==input.workspaceId||outbox.content.taskId!==input.taskId||outbox.content.deliveryId!==input.deliveryId
          ||outbox.content.baselineCommit!==input.baselineCommit||JSON.stringify(outbox.content.validation)!==JSON.stringify(journal.validation))fail();
        const id=`legacy-publication:${hash(intent.id)}`,prior=records.get(id);
        if(prior)fail();
        if(!Number.isSafeInteger(row.generation+1))fail();
        records.put(id,{kind:'legacy-publication-migration',conversationId:input.conversationId,intentId:intent.id,state:'pending',
          originalJournal:journal,originalOutbox:outbox,createdAt:now()});
        records.put(journal.id,{...journal,legacyMigrationId:id,state:'remote_pending',validation:null,updatedAt:now()});
        records.put(intent.id,{...intent,state:'pending',remotePublicationRequired:true,updatedAt:now()});
        // A newer scheduling generation forces a fresh native turn identity.
        // The target lease generation is retained and advanced only by claim.
        store.db.run("UPDATE task_integration_work SET state='pending',generation=?,code=NULL,attempts=0,next_attempt_at=0 WHERE account_id=? AND intent_id=? AND state='done' AND generation=?",
          row.generation+1,store.accountId,intent.id,row.generation);
      })();}catch(error){
        assertActive();if(error.code!=='COLLAB_PUBLICATION_MIGRATION_INVALID')throw error;
        // Retain inconsistent records for repair and surface failure per task;
        // one bad historical row must not block unrelated native admissions.
        store.db.run("UPDATE task_integration_work SET code='COLLAB_PUBLICATION_MIGRATION_INVALID' WHERE account_id=? AND intent_id=? AND state='done' AND generation=?",store.accountId,row.intent_id,row.generation);
      }
      cursor=row.intent_id;
    }
    if(rows.length<8)done=true;
  }
  return {recover(){if(!running)running=scan().finally(()=>{running=null;});return running;}};
}
module.exports={createLegacyPublicationMigration};
