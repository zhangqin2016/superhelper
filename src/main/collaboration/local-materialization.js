"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {createHash,randomUUID}=require("node:crypto");
const {createTaskRecords}=require("./task-records");
const {prepareLocalCandidate,LOCAL_CANDIDATE_POLICY}=require("./task-local-candidate");
const {readTaskFile,safeTaskRoot}=require("./task-application");
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail=name=>Object.assign(Error(`COLLAB_LOCAL_MATERIALIZATION_${name}`),{code:`COLLAB_LOCAL_MATERIALIZATION_${name}`});
const jobId=intentId=>`local-materialization:${hash(intentId)}`;
const identity=root=>{safeTaskRoot(root);const stat=fs.statSync(root);return `${stat.dev}:${stat.ino}`;};

/** Durable private candidate preparation. A advances only with a future local
 * materialization receipt, never merely because shared publication succeeded. */
function createLocalMaterialization({store,taskGit,rootPath,deviceId,assertActive,authorize}){
  const records=createTaskRecords({store,assertActive});
  if(typeof authorize!=="function")throw fail("INVALID");
  async function prepare({intentId,input,localRoot,baseline,published}){
    const authorized=async()=>{assertActive();if(await authorize(input)!==true)throw fail("ACCESS_DENIED");assertActive();};
    await authorized();
    if(published?.state!=="published"||published.intentId!==intentId||published.candidate?.state!=="ready"
      ||published.candidate.commit!==published.publication?.commit||published.remoteReceipt?.headCommit!==published.candidate.commit
      ||published.remoteReceipt.workspaceId!==input.workspaceId||!Number.isSafeInteger(published.remoteReceipt.revision)||published.remoteReceipt.revision<1
      ||baseline.commit!==input.baselineCommit)throw fail("PUBLICATION_REQUIRED");
    const binding={accountId:store.accountId,deviceId,workspaceId:input.workspaceId,projectId:input.projectId,sessionId:input.sessionId,
      targetId:input.targetId,localRoot:safeTaskRoot(localRoot),rootIdentity:identity(localRoot)};
    const baseId=`local-materialization-base:${hash([deviceId,input.workspaceId,input.targetId])}`,id=jobId(intentId);
    const base=store.db.transaction(()=>{
      const existing=records.get(baseId);
      if(existing){if(hash(existing.binding)!==hash(binding))throw fail("BINDING_CONFLICT");return existing;}
      // Initial shared H is the only automatic seed. An arbitrary task B may
      // already contain private changes and is not evidence of last synced A.
      if(published.candidate.head!==baseline.commit||published.remoteReceipt.revision!==1)return null;
      return records.put(baseId,{id:baseId,kind:"local-materialization-base",conversationId:input.conversationId,binding,
        revision:{ref:baseline.ref,commit:baseline.commit},remoteRevision:0,generation:0});
    })();
    if(!base){records.put(id,{id,kind:"local-materialization",conversationId:input.conversationId,intentId,binding,state:"baseline_required"});return {state:"baseline_required"};}
    if(!Number.isSafeInteger(base.remoteRevision)||base.remoteRevision<0||published.remoteReceipt.revision<base.remoteRevision
      ||published.remoteReceipt.revision===base.remoteRevision&&published.candidate.commit!==base.revision.commit)throw fail("STALE_PUBLICATION");
    const revision={ref:published.candidate.ref,commit:published.candidate.commit,remoteRevision:published.remoteReceipt.revision};
    const fingerprint=hash({policy:LOCAL_CANDIDATE_POLICY,binding,base:base.revision,baseGeneration:base.generation,baseRemoteRevision:base.remoteRevision,revision});
    const previous=records.get(id);
    if(previous&&hash(previous.binding)!==hash(binding))throw fail("BINDING_CONFLICT");
    if(previous?.state==="applied"&&hash(previous.sharedRevision)===hash(revision)
      &&base.receipt?.applicationId===previous.applicationId&&base.revision.commit===revision.commit)return previous;
    const recovery=previous?.applicationId?require("./task-recovery").createTaskRecovery({store,assertActive}).get(previous.applicationId):null;
    if(recovery?.journal&&!["rolled_back","applied"].includes(recovery.state))throw fail("RECOVERY_REQUIRED");
    const intact=value=>{
      if(recovery?.state==="rolled_back")return false;
      if(value?.fingerprint!==fingerprint||!["ready","conflicts"].includes(value.state))return false;
      try{
        safeTaskRoot(value.candidate.snapshotRoot);
        for(const file of value.candidate.manifest)if(readTaskFile(value.candidate.snapshotRoot,file.path)?.sha256!==file.sha256)return false;
        const current=new Map(value.candidate.currentManifest.map(file=>[file.path,file.sha256]));
        return value.candidate.paths.every(name=>(readTaskFile(localRoot,name)?.sha256||null)===(current.get(name)||null));
      }catch{return false;}
    };
    if(intact(previous))return previous;
    const token=randomUUID();
    const attempt=path.join(rootPath,`local-${token}`);
    records.put(id,{id,kind:"local-materialization",conversationId:input.conversationId,taskId:input.taskId,deliveryId:input.deliveryId,intentId,binding,baseId,
      baseRevision:base.revision,baseGeneration:base.generation,baseRemoteRevision:base.remoteRevision,sharedRevision:revision,fingerprint,token,attemptRoot:attempt,state:"preparing"});
    const guard=()=>{
      assertActive();
      if(records.get(id)?.token!==token||hash(records.get(baseId))!==hash(base)||identity(localRoot)!==binding.rootIdentity)throw fail("FENCED");
    };
    try{
      fs.mkdirSync(rootPath,{recursive:true,mode:0o700});safeTaskRoot(rootPath);guard();
      fs.mkdirSync(attempt,{mode:0o700});
      const context=await taskGit.ensure();guard();
      const snapshot=async(rev,name)=>{
        const parents=(await context.git(["rev-list","--parents","-n","1",rev.commit])).split(" ").slice(1);guard();
        const result=await taskGit.materializeSnapshot({revision:rev,parents,destinationRoot:path.join(attempt,name)});guard();
        return {rootPath:result.snapshotRoot,manifest:result.manifest};
      };
      const a=await snapshot(base.revision,"a"),m=await snapshot(revision,"m"),stage=path.join(attempt,"private");fs.mkdirSync(stage,{mode:0o700});
      const candidate=await prepareLocalCandidate({base:a,shared:m,rootPath:localRoot,destinationRoot:stage,assertActive:guard});guard();
      await authorized();guard();
      // Shared refs/objects receive no W bytes. A remains unchanged until a
      // separate, verified writer commits W' and its local receipt.
      return records.put(id,{...records.get(id),state:candidate.state,candidate});
    }catch(error){
      if(records.get(id)?.token===token)records.put(id,{...records.get(id),state:"failed",code:/^COLLAB_[A-Z_]+$/.test(error.code||"")?error.code:"COLLAB_LOCAL_MATERIALIZATION_FAILED"});
      throw error;
    }
  }
  return {prepare,get:intentId=>records.get(jobId(intentId))};
}
module.exports={createLocalMaterialization};
