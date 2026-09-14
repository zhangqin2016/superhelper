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

/** Local publication journal and outbox. Required authorize/validate callbacks
 * belong to the production domain/validator, never renderer-supplied booleans.
 * Git atomically records the publication receipt with H->M; SQLite completion
 * and the encrypted outbound intent are a second, recoverable transaction. */
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
    async run({lease,baseline,delivery,validationPolicyId,validate}){
      const guard=()=>intents.assertLease(lease);
      guard();const intent=intents.get(lease.intentId),input=intent.input;
      if(input.chain!=="shared" || typeof validate!=="function" || typeof validationPolicyId!=="string"
        || !/^[A-Za-z0-9_.:-]{1,160}$/.test(validationPolicyId))throw fail("INVALID");
      const authorized=async()=>{guard();if(await authorize(input)!==true)throw fail("ACCESS_DENIED");guard();};
      await authorized();
      if(baseline?.commit!==input.baselineCommit || delivery?.commit!==input.deliveryCommit)throw fail("BINDING_CONFLICT");
      let journal=get(intent.id);
      const save=patch=>{guard();journal=records.put(journalId(intent.id),{...journal,...patch,id:journalId(intent.id),kind:"shared-publication",
        conversationId:input.conversationId,intentId:intent.id,updatedAt:now()});return journal;};
      const finish=publication=>store.db.transaction(()=>{
        guard();
        if(publication.commit!==journal.candidate.commit || !validation(journal.validation,journal.candidate,journal.validation?.policyId))throw fail("VALIDATION_MISSING");
        const id=`publication-outbox:${hash([intent.id,publication.commit])}`;
        const content={workspaceId:input.workspaceId,taskId:input.taskId,deliveryId:input.deliveryId,baselineCommit:input.baselineCommit,
          expectedHead:journal.candidate.head,commit:publication.commit,tree:journal.candidate.tree,validation:journal.validation};
        const previous=records.get(id);
        if(previous && JSON.stringify(previous.content)!==JSON.stringify(content))throw fail("OUTBOX_CONFLICT");
        if(!previous)records.put(id,{id,kind:"publication-outbox",conversationId:input.conversationId,intentId:intent.id,content,state:"queued",createdAt:now()});
        save({state:"published",publication,outboxId:id});intents.complete(lease);
        return journal;
      })();
      if(journal?.candidate?.state==="ready"){
        const publication=await sharedGit.publication(journal.candidate);guard();
        if(publication)return finish(publication);
      }
      const head=await sharedGit.initialize({workspaceId:input.workspaceId,baseline});guard();
      if(!journal?.candidate || journal.candidate.head!==head.commit || journal.candidate.state!=="ready"){
        const candidate=await sharedGit.prepare({workspaceId:input.workspaceId,baseline,delivery,expectedHead:head.commit});guard();
        save({state:candidate.state==="conflicts"?"conflicts":"candidate",candidate,validation:null});
      }
      if(journal.state==="conflicts"){
        intents.release(lease);return journal;
      }
      if(!validation(journal.validation,journal.candidate,validationPolicyId)){
        const result=await validate(Object.freeze({...journal.candidate}));guard();
        const evidence=validation(result,journal.candidate,validationPolicyId);
        if(!evidence){save({state:"validation_failed",validation:null});intents.release(lease);return journal;}
        save({state:"validated",validation:evidence});
      }
      await authorized();save({state:"publishing"});
      const publication=await sharedGit.publish({candidate:journal.candidate,validate:async()=>{guard();return journal.validation;}});
      guard();return finish(publication);
    },
  });
}
module.exports={createSharedPublication};
