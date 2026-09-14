"use strict";
const {createHash}=require("node:crypto");
const identity=value=>value && typeof value==="object" && !Array.isArray(value)
  && Object.keys(value).length===2 && typeof value.accountId==="string" && /^[A-Za-z0-9_-]{1,200}$/.test(value.accountId)
  && typeof value.intentId==="string" && /^integration:[a-f0-9]{64}$/.test(value.intentId)
  ? Object.freeze({accountId:value.accountId,intentId:value.intentId}):null;
const fail=code=>Object.assign(Error(`COLLAB_INTEGRATION_${code}`),{code:`COLLAB_INTEGRATION_${code}`});
const descriptions={
  validation_required:"The shared candidate is ready for project validation.",
  validation_failed:"The shared candidate did not pass project validation.",
  conflict:"The shared candidate needs conflict resolution.",
  published:"The shared version was prepared locally and is waiting to sync.",
  cancelled:"Collaboration integration was cancelled.",
  queued:"Collaboration integration remains queued.",
};
const translated={
  "zh-CN":{start:"整合协作任务交付",validation_required:"共享候选版本已准备，等待项目验证。",validation_failed:"共享候选版本未通过项目验证。",conflict:"共享候选版本存在待解决的冲突。",published:"共享版本已在本机生成，等待同步。",cancelled:"协作集成已取消。",queued:"协作集成仍在排队。"},
  ar:{start:"دمج تسليم المهمة المشتركة",validation_required:"الإصدار المرشح المشترك جاهز للتحقق من المشروع.",validation_failed:"لم يجتز الإصدار المرشح المشترك التحقق من المشروع.",conflict:"يحتاج الإصدار المرشح المشترك إلى حل التعارضات.",published:"تم إعداد الإصدار المشترك محليًا وهو بانتظار المزامنة.",cancelled:"تم إلغاء دمج التعاون.",queued:"لا يزال دمج التعاون في قائمة الانتظار."},
};
function label(key){
  let locale="en";try{locale=require("../locale-settings").getLocale();}catch{/* Embedded hosts use English. */}
  return translated[locale]?.[key] || descriptions[key] || "Integrate the shared task delivery";
}
async function enqueueIntegrationTurn(orchestrator,value){
  if(!value || Object.keys(value).sort().join(",")!=="accountId,attempt,intentId,sessionId"
    || typeof value.sessionId!=="string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.sessionId) || !Number.isSafeInteger(value.attempt)||value.attempt<0)return {ok:false,error:"COLLAB_INTEGRATION_INVALID"};
  const operation=identity({accountId:value.accountId,intentId:value.intentId});
  if(!operation)return {ok:false,error:"COLLAB_INTEGRATION_INVALID"};
  const key=createHash("sha256").update(JSON.stringify([value.sessionId,operation,value.attempt])).digest("hex");
  return orchestrator.sendUserMessage(value.sessionId,label("start"),[],{
    turnId:`turn_collaboration_${key}`,durableQueueKey:`collaboration:${key}`,queueOrigin:"collaboration",queueVisibility:"background",recordUser:false,
    localAssistant:{collaborationIntegration:operation},
  });
}
async function runIntegrationTurn(orchestrator,session,state,value){
  const operation=identity(value);
  if(!operation || typeof orchestrator.ctx.executeCollaborationIntegration!=="function")throw fail("UNAVAILABLE");
  const turnId=state.turnId,generation=state.turnGeneration,ownerScope=state.taskAdmission?.ownerScope;
  const assertActive=()=>{
    const owner=orchestrator.ctx.sessionManager.resolveTurnOwnerScope?.(session.id);
    if(state.turnId!==turnId || state.turnGeneration!==generation || state.terminalEmitted || state.startInFlight?.cancelled
      || !owner?.ok || !ownerScope || owner.ownerScope!==ownerScope)throw fail("FENCED");
  };
  assertActive();
  const result=await orchestrator.ctx.executeCollaborationIntegration({...operation,sessionId:session.id},{turnId,assertActive});
  assertActive();
  if(result?.ok!==true || !Object.hasOwn(descriptions,result.state))throw fail("FAILED");
  return {assistant:label(result.state),failed:result.state==="validation_failed"};
}
module.exports={enqueueIntegrationTurn,runIntegrationTurn};
