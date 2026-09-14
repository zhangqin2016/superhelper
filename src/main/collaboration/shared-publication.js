"use strict";
const {createHash}=require("node:crypto");
const {createTaskRecords}=require("./task-records");
const {createIntegrationIntents}=require("./integration-intents");
const {createSharedGit}=require("./shared-git");
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail=code=>Object.assign(new Error(`COLLAB_PUBLICATION_${code}`),{code:`COLLAB_PUBLICATION_${code}`});
const journalId=id=>`shared-publication:${hash(id)}`;
function validation(value,candidate,policyId){
  if(value?.ok!==true || value.commit!==candidate.commit || value.policyId!==policyId
    || typeof value.evidenceHash!=="string" || !/^[a-f0-9]{64}$/.test(value.evidenceHash))return null;
  return {ok:true,commit:value.commit,policyId,evidenceHash:value.evidenceHash};
}

/** Publication journal and outbox. Required guards belong to the native domain.
 * Negotiated remote mode confirms the server publication and canonical H before
 * recording the local Git receipt and completing SQLite work. Legacy mode keeps
 * its outbound intent queued. Neither path accepts renderer validation claims. */
function createSharedPublication({store,taskGit,sharedGit=createSharedGit(taskGit),assertActive,authorize,now=Date.now}){
  if(typeof authorize!=="function")throw new TypeError("Publication requires fresh authorization");
  const records=createTaskRecords({store,assertActive}),intents=createIntegrationIntents({store,assertActive,now});
  function get(intentId){
    const value=records.get(journalId(intentId));
    if(value && (value.kind!=="shared-publication" || value.intentId!==intentId))throw fail("BINDING_CONFLICT");
    return value;
  }
  return Object.freeze({
    get,
    outbox(conversationId){return records.list(conversationId).filter(value=>value.kind==="publication-outbox");},
    async run({lease,baseline,delivery,validationPolicyId,validate,remote,resolve=null}){
      const guard=()=>intents.assertLease(lease);
      guard();const intent=intents.get(lease.intentId),input=intent.input;
      if(intent.remotePublicationRequired===true&&!remote)throw fail('REMOTE_REQUIRED');
      if(input.chain!=="shared" || typeof validate!=="function" || typeof validationPolicyId!=="string"
        || !/^[A-Za-z0-9_.:-]{1,160}$/.test(validationPolicyId))throw fail("INVALID");
      const authorized=async()=>{guard();if(await authorize(input)!==true)throw fail("ACCESS_DENIED");guard();};
      await authorized();
      if(baseline?.commit!==input.baselineCommit || delivery?.commit!==input.deliveryCommit)throw fail("BINDING_CONFLICT");
      if(remote&&intent.remotePublicationRequired!==true)records.put(intent.id,{...intent,remotePublicationRequired:true,updatedAt:now()});
      let journal=get(intent.id);
      const save=patch=>{guard();journal=records.put(journalId(intent.id),{...journal,...patch,id:journalId(intent.id),kind:"shared-publication",
        conversationId:input.conversationId,intentId:intent.id,updatedAt:now()});return journal;};
      const finish=publication=>store.db.transaction(()=>{
        guard();
        if(publication.commit!==journal.candidate.commit || !validation(journal.validation,journal.candidate,journal.validation?.policyId))throw fail("VALIDATION_MISSING");
        const id=`publication-outbox:${hash(remote?[intent.id,publication.commit,journal.validation.policyId,journal.validation.evidenceHash]:[intent.id,publication.commit])}`;
        const content={workspaceId:input.workspaceId,taskId:input.taskId,deliveryId:input.deliveryId,baselineCommit:input.baselineCommit,
          expectedHead:journal.candidate.head,commit:publication.commit,tree:journal.candidate.tree,validation:journal.validation};
        const previous=records.get(id);
        if(previous && JSON.stringify(previous.content)!==JSON.stringify(content))throw fail("OUTBOX_CONFLICT");
        if(remote&&(!journal.remoteReceipt||journal.remoteReceipt.headCommit!==publication.commit||journal.remoteReceipt.workspaceId!==input.workspaceId))throw fail('REMOTE_RECEIPT_MISSING');
        if(!previous||remote)records.put(id,{...previous,id,kind:"publication-outbox",conversationId:input.conversationId,intentId:intent.id,content,
          state:remote?'sent':'queued',...(remote?{receipt:journal.remoteReceipt}:{}),createdAt:previous?.createdAt||now()});
        if(journal.legacyMigrationId){
          const migration=records.get(journal.legacyMigrationId),old=migration&&records.get(migration.originalOutbox?.id);
          if(!remote||migration?.kind!=='legacy-publication-migration'||migration.intentId!==intent.id||!old||old.intentId!==intent.id
            ||old.kind!=='publication-outbox'||!['queued','superseded'].includes(old.state)||old.id===id
            ||JSON.stringify(old.content)!==JSON.stringify(migration.originalOutbox.content))throw fail('MIGRATION_CONFLICT');
          if(old.state==='superseded'&&old.supersededBy!==id)throw fail('MIGRATION_CONFLICT');
          records.put(old.id,{...old,state:'superseded',supersededBy:id,receipt:journal.remoteReceipt,updatedAt:now()});
          records.put(migration.id,{...migration,state:'confirmed',outboxId:id,receipt:journal.remoteReceipt,updatedAt:now()});
        }
        save({state:"published",publication,outboxId:id});intents.complete(lease);
        return journal;
      })();
      if(remote){
        const recovered=await remote.recover(journal);guard();
        if(recovered){
          save({remoteReceipt:recovered});
          const canonicalHead=await remote.canonical(baseline);guard();await authorized();
          const publication=await sharedGit.publish({candidate:journal.candidate,canonicalHead,validate:async()=>{guard();return journal.validation;}});
          guard();return finish(publication);
        }
      }
      if(!remote&&journal?.candidate?.state==="ready"){
        const publication=await sharedGit.publication(journal.candidate);guard();
        if(publication)return finish(publication);
      }
      const head=remote?await remote.acquire(baseline):await sharedGit.initialize({workspaceId:input.workspaceId,baseline});guard();
      if(!journal?.candidate || journal.candidate.head!==head.commit || journal.candidate.state!=="ready"){
        const candidate=await sharedGit.prepare({workspaceId:input.workspaceId,baseline,delivery,expectedHead:head.commit,resolve});guard();
        save({state:candidate.state==="conflicts"?"conflicts":"candidate",candidate,validation:null,remoteReceipt:null});
      }
      if(journal.state==="conflicts"){
        intents.release(lease);return journal;
      }
      if(!validation(journal.validation,journal.candidate,validationPolicyId)){
        const result=await validate(Object.freeze({...journal.candidate}));guard();
        const evidence=validation(result,journal.candidate,validationPolicyId);
        if(!evidence){
          const attempt=result?.commit===journal.candidate.commit && result.policyId===validationPolicyId && /^[a-f0-9]{64}$/.test(result.evidenceHash||"")
            ? {commit:result.commit,policyId:validationPolicyId,evidenceHash:result.evidenceHash,state:result.state==="required"?"required":"failed"}:null;
          save({state:"validation_failed",validation:null,validationAttempt:attempt});intents.release(lease);return journal;
        }
        save({state:"validated",validation:evidence});
      }
      await authorized();save({state:"publishing"});
      let canonicalHead;
      if(remote){
        const remoteReceipt=await remote.publish(journal.candidate,journal.validation);guard();save({remoteReceipt});
        canonicalHead=await remote.canonical(baseline);guard();await authorized();
      }
      const publication=await sharedGit.publish({candidate:journal.candidate,canonicalHead,validate:async()=>{guard();return journal.validation;}});
      guard();return finish(publication);
    },
  });
}
module.exports={createSharedPublication};
