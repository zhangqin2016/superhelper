"use strict";
const stages=new Set(["queued","preparing","validation_required","conflict","decision_required","failed","publication_pending","published","cancelled","binding_required"]);
const questionsView=value=>Array.isArray(value)?value.slice(0,8).filter(item=>typeof item?.path==="string"&&typeof item.question==="string"&&item.question.trim())
  .map(item=>({path:item.path.slice(0,300),question:item.question.trim().slice(0,500)})):[];
const localStages=new Set(["preparing","waiting","ready","validation_required","validation_failed","conflict","baseline_required","failed","applied","undone"]);
function integrationView(value){
  return value && stages.has(value.stage) && /^[A-Za-z0-9_-]{1,200}$/.test(value.deliveryId||"")
    ? {stage:value.stage,deliveryId:value.deliveryId,canRetry:value.canRetry===true,
      ...(value.stage==="published"&&localStages.has(value.localStage)?{localStage:value.localStage}:{}),
      ...(questionsView(value.questions).length?{questions:questionsView(value.questions)}:{}),
      ...(value.canConfigureChecks===true?{canConfigureChecks:true}:{}),
      ...(Number.isInteger(value.checkCount)&&value.checkCount>=0&&value.checkCount<=32?{checkCount:value.checkCount}:{})} : null;
}
function integrationIndex(records){
  const byTask=new Map(),sent=new Set(),local=new Map(),publications=new Map();
  for(const row of records){
    if(row.kind==="integration-intent"){const list=byTask.get(row.input.taskId)||[];list.push(row);byTask.set(row.input.taskId,list);}
    if(row.kind==="publication-outbox" && row.state==="sent")sent.add(row.intentId);
    if(row.kind==="local-materialization")local.set(row.intentId,local.has(row.intentId)?null:row);
    if(row.kind==="shared-publication")publications.set(row.intentId,row);
  }
  return {byTask,sent,local,publications};
}
function localStage(job,intent,task,work){
  if(!job)return work.code==="COLLAB_LOCAL_APPLICATION_PENDING"?"waiting":undefined;
  if(job.taskId!==task.id||job.deliveryId!==task.currentDeliveryId||job.binding?.accountId!==task.requesterUserId
    ||["workspaceId","targetId","projectId","sessionId"].some(key=>job.binding[key]!==intent.input[key]))return undefined;
  if(job.state==="undone")return job.receipt?.applicationId===job.applicationId&&/^[A-Za-z0-9_-]{1,200}$/.test(job.undoApplicationId||"")?"undone":undefined;
  if(job.state==="applied"){
    const receipt=job.receipt;
    return receipt&&job.applicationId&&receipt.applicationId===job.applicationId&&receipt.token===job.token
      &&receipt.fingerprint===job.fingerprint&&job.validation?.state==="passed"&&receipt.validationHash===job.validation.evidenceHash
      &&/^[a-f0-9]{64}$/.test(job.validation.evidenceHash||"")&&/^[a-f0-9]{40}$/.test(job.sharedRevision?.commit||"")
      &&Number.isSafeInteger(job.sharedRevision?.remoteRevision)&&job.sharedRevision.remoteRevision>0
      &&receipt.sharedRevision?.commit===job.sharedRevision?.commit&&receipt.sharedRevision?.remoteRevision===job.sharedRevision?.remoteRevision
      ?"applied":"validation_required";
  }
  if(job.state==="conflicts")return "conflict";
  if(["failed","baseline_required","preparing"].includes(job.state))return job.state;
  if(job.validation?.state==="failed")return "validation_failed";
  if(job.validation?.state==="required")return "validation_required";
  if(work.code==="COLLAB_LOCAL_APPLICATION_PENDING")return "waiting";
  return job.state==="ready"?(job.validation?.state==="passed"?"ready":"validation_required"):undefined;
}
function taskIntegration(task,records,workById,validationAvailable=false,bindingRequired=false){
  if(!task?.currentDeliveryId)return null;
  const index=Array.isArray(records)?integrationIndex(records):records;
  const matches=(index.byTask.get(task.id)||[]).filter(row=>row.input.deliveryId===task.currentDeliveryId
    && row.input.workspaceId===task.sharedWorkspaceId && row.input.chain==="shared");
  if(!matches.length && bindingRequired)return {status:{stage:"binding_required",deliveryId:task.currentDeliveryId,canRetry:false}};
  if(matches.length!==1)return null;
  const intent=matches[0],work=workById.get(intent.id);if(!work)return null;
  let stage;
  if(intent.state==="cancelled")stage="cancelled";
  else if(intent.state==="completed")stage=work.code==='COLLAB_PUBLICATION_MIGRATION_INVALID'?'failed':index.sent.has(intent.id)?"published":"publication_pending";
  else if(work.state==="running")stage="preparing";
  else if(work.code==="COLLAB_INTEGRATION_VALIDATION_REQUIRED")stage="validation_required";
  else if(work.code==="COLLAB_INTEGRATION_CONFLICT")stage="conflict";
  else if(work.code==="COLLAB_INTEGRATION_DECISION_REQUIRED")stage="decision_required";
  else stage=work.code?"failed":"queued";
  const localJob=stage==="published"?index.local?.get(intent.id):null;
  const local=stage==="published"?localStage(localJob,intent,task,work):undefined;
  // Questions the model could not answer from the goal travel with the status
  // so the requester can decide; answering re-admits the same intent.
  const publication=index.publications?.get(intent.id);
  const questions=["conflict","decision_required"].includes(stage)?(publication?.repair?.questions?.length?publication.repair.questions:publication?.candidate?.repair?.questions)
    :local==="conflict"?localJob?.candidate?.repair?.questions:null;
  return {intent,work,status:{stage,...(local?{localStage:local}:{}),...(questionsView(questions).length?{questions:questionsView(questions)}:{}),deliveryId:task.currentDeliveryId,canRetry:intent.state==="pending"
    && ["waiting","pending"].includes(work.state) && (["failed","conflict","decision_required"].includes(stage) || stage==="validation_required" && validationAvailable)}};
}
module.exports={integrationView,taskIntegration,integrationIndex};
