"use strict";
const fs=require("node:fs");
const {createHash}=require("node:crypto");
const {createTaskRecords}=require("./task-records");
const {createTaskRecovery}=require("./task-recovery");
const {createTaskApplication,readTaskFile,safeTaskRoot}=require("./task-application");
const hash=value=>createHash("sha256").update(JSON.stringify(value??null)).digest("hex");
const fail=code=>Object.assign(Error(`COLLAB_LOCAL_APPLICATION_${code}`),{code:`COLLAB_LOCAL_APPLICATION_${code}`});

/** The supplied writer must include foreground admission as well as the local
 * broker lock. Do not enable automatic application with a broker-only writer. */
function createLocalMaterializationApplication({store,writer,journalRoot,assertActive,authorize,getPolicy,beforeReceipt=()=>{}}){
  if(typeof writer?.run!=="function"||typeof authorize!=="function"||typeof getPolicy!=="function")throw fail("CONFIG_INVALID");
  const records=createTaskRecords({store,assertActive}),recoveries=createTaskRecovery({store,assertActive});
  async function apply({job,input}){
    assertActive();if(await authorize(input)!==true)throw fail("ACCESS_DENIED");assertActive();
    const current=records.get(job.id);
    if(!current||current.token!==job.token||current.fingerprint!==job.fingerprint)throw fail("FENCED");
    if(current.binding?.accountId!==store.accountId||input.conversationId!==current.conversationId||input.taskId!==current.taskId||input.deliveryId!==current.deliveryId
      ||["workspaceId","targetId","projectId","sessionId"].some(key=>input[key]!==current.binding[key]))throw fail("BINDING_CONFLICT");
    if(current.state==="applied"){
      const receipt=recoveries.get(current.applicationId);
      if(receipt?.journal?.state!=="applied")throw fail("RECEIPT_REQUIRED");
      return {state:"applied",applicationId:current.applicationId};
    }
    job=current;
    const validation=job.validation,base=records.get(job.baseId);
    function guard(){
      assertActive();const live=records.get(job.id),evidence=validation&&records.get(validation.evidenceId);
      if(live?.state!=="ready"||live.token!==job.token||live.fingerprint!==job.fingerprint||hash(live.candidate)!==hash(job.candidate)
        ||hash(live.validation)!==hash(validation))throw fail("FENCED");
      if(validation?.state!=="passed"||!validation.checkPolicyId||(getPolicy(input)?.id||null)!==validation.checkPolicyId
        ||evidence?.state!=="passed"||evidence.evidenceHash!==validation.evidenceHash||hash(evidence.report)!==validation.evidenceHash
        ||evidence.report.state!=="passed"||evidence.report.candidateUnchanged!==true||evidence.report.token!==job.token
        ||evidence.report.fingerprint!==job.fingerprint||evidence.report.checkPolicyId!==validation.checkPolicyId
        ||evidence.report.privateCommit!==validation.privateCommit)throw fail("VALIDATION_REQUIRED");
      const actualBase=records.get(job.baseId);
      if(!base||!Number.isSafeInteger(base.generation)||base.generation<0||base.generation>=Number.MAX_SAFE_INTEGER
        ||hash(actualBase)!==hash(base)||base.generation!==job.baseGeneration||base.remoteRevision!==job.baseRemoteRevision
        ||hash(base.revision)!==hash(job.baseRevision)||hash(base.binding)!==hash(job.binding))throw fail("BASE_CHANGED");
      if(job.binding.accountId!==store.accountId||["workspaceId","targetId","projectId","sessionId"].some(key=>input[key]!==job.binding[key])
        ||input.conversationId!==job.conversationId)throw fail("BINDING_CONFLICT");
      const root=safeTaskRoot(job.binding.localRoot),stat=fs.statSync(root);
      if(`${stat.dev}:${stat.ino}`!==job.binding.rootIdentity)throw fail("FENCED");
      if(!Number.isSafeInteger(job.sharedRevision.remoteRevision)||job.sharedRevision.remoteRevision<=base.remoteRevision)throw fail("BASE_CHANGED");
    }
    guard();
    const applicationId=`materialize-${hash([job.id,job.token,job.fingerprint])}`;
    const binding={applicationId,rootPath:job.binding.localRoot,deliveryRoot:job.candidate.snapshotRoot,
      baseManifest:job.candidate.currentManifest,deliveryManifest:job.candidate.manifest,editablePaths:job.candidate.paths};
    fs.mkdirSync(journalRoot,{recursive:true,mode:0o700});
    const broker=createTaskApplication({journalRoot:safeTaskRoot(journalRoot),assertAuthorized:async()=>{if(await authorize(input)!==true)throw fail("ACCESS_DENIED");guard();},
      writer:{run:operation=>writer.run(()=>{guard();return operation();})},
      journal:{get:id=>recoveries.get(id)?.journal||null,put:(id,journal)=>store.db.transaction(()=>{
        guard();const recovery=recoveries.get(id);
        if(!recovery)throw fail("RECEIPT_REQUIRED");
        if(journal.state==="applied"){
          // The last per-file checkpoint alone is not a whole-candidate receipt.
          const desired=new Map(job.candidate.manifest.map(file=>[file.path,file.sha256]));
          for(const name of job.candidate.paths)if((readTaskFile(binding.rootPath,name)?.sha256||null)!==(desired.get(name)||null))throw fail("STALE_WORKSPACE");
          beforeReceipt();guard();
          const receipt={applicationId,token:job.token,fingerprint:job.fingerprint,validationHash:validation.evidenceHash,
            sharedRevision:job.sharedRevision,previousGeneration:base.generation,manifest:job.candidate.manifest};
          records.put(job.baseId,{...base,revision:{ref:job.sharedRevision.ref,commit:job.sharedRevision.commit},
            remoteRevision:job.sharedRevision.remoteRevision,generation:base.generation+1,receipt});
          records.put(job.id,{...records.get(job.id),state:"applied",applicationId,receipt});
        }
        recoveries.put(id,{...recovery,journal,state:journal.state});
      })()}});
    const previous=recoveries.get(applicationId);
    let planHash=previous?.planHash;
    if(!previous){
      const before=new Map(job.candidate.currentManifest.map(file=>[file.path,file.sha256]));
      for(const name of job.candidate.paths)if((readTaskFile(binding.rootPath,name)?.sha256||null)!==(before.get(name)||null))throw fail("STALE_WORKSPACE");
      const preview=await broker.preview(binding);guard();planHash=preview.planHash;
      store.db.transaction(()=>{
        guard();recoveries.put(applicationId,{id:applicationId,kind:"materialization",conversationId:input.conversationId,taskId:input.taskId,deliveryId:input.deliveryId,
          input:binding,planHash,state:"planned",createdAt:store.now()});
        records.put(job.id,{...records.get(job.id),applicationId});
      })();
    }
    await broker.apply({...binding,expectedPlanHash:planHash,confirmDeletions:true});
    return {state:"applied",applicationId};
  }
  return {apply};
}
module.exports={createLocalMaterializationApplication};
