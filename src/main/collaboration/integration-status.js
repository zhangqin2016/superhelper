"use strict";
const stages=new Set(["queued","preparing","validation_required","conflict","failed","publication_pending","published","cancelled","binding_required"]);
function integrationView(value){
  return value && stages.has(value.stage) && /^[A-Za-z0-9_-]{1,200}$/.test(value.deliveryId||"")
    ? {stage:value.stage,deliveryId:value.deliveryId,canRetry:value.canRetry===true} : null;
}
function integrationIndex(records){
  const byTask=new Map(),sent=new Set();
  for(const row of records){
    if(row.kind==="integration-intent"){const list=byTask.get(row.input.taskId)||[];list.push(row);byTask.set(row.input.taskId,list);}
    if(row.kind==="publication-outbox" && row.state==="sent")sent.add(row.intentId);
  }
  return {byTask,sent};
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
  else if(intent.state==="completed")stage=index.sent.has(intent.id)?"published":"publication_pending";
  else if(work.state==="running")stage="preparing";
  else if(work.code==="COLLAB_INTEGRATION_VALIDATION_REQUIRED")stage="validation_required";
  else if(work.code==="COLLAB_INTEGRATION_CONFLICT")stage="conflict";
  else stage=work.code?"failed":"queued";
  return {intent,work,status:{stage,deliveryId:task.currentDeliveryId,canRetry:intent.state==="pending"
    && ["waiting","pending"].includes(work.state) && (stage==="failed" || stage==="validation_required" && validationAvailable)}};
}
module.exports={integrationView,taskIntegration,integrationIndex};
