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
  decision_required:"The shared candidate needs one decision from the requester before integration can continue.",
  published:"The shared version was prepared locally and is waiting to sync.",
  cancelled:"Collaboration integration was cancelled.",
  queued:"Collaboration integration remains queued.",
  failed:"Collaboration integration could not complete. See the task for retry status.",
  local_ready:"The shared version is published. A local candidate preserving private edits is ready; workspace files have not been applied.",
  local_applied:"The shared version is published and the validated local candidate has been applied to the workspace.",
  local_waiting:"The shared version is published. Local application will resume when foreground work is idle.",
  local_conflicts:"The shared version is published. Local edits need conflict resolution before application.",
  local_baseline_required:"The shared version is published. The last synchronized local baseline must be recovered before application.",
  local_validation_passed:"The shared version is published and the private candidate passed local checks. Workspace files have not been applied.",
  local_validation_failed:"The shared version is published. The private candidate failed local checks; workspace files have not been applied.",
  local_validation_required:"The shared version is published. The private candidate still requires local checks before application.",
};
const translated={
  "zh-CN":{start:"整合协作任务交付",validation_required:"共享候选版本已准备，等待项目验证。",validation_failed:"共享候选版本未通过项目验证。",conflict:"共享候选版本存在待解决的冲突。",decision_required:"共享候选版本需要发起人先回答一个问题，整合才能继续。",published:"共享版本已在本机生成，等待同步。",cancelled:"协作集成已取消。",queued:"协作集成仍在排队。",failed:"协作集成未能完成，请查看任务中的重试状态。"},
  ar:{start:"دمج تسليم المهمة المشتركة",validation_required:"الإصدار المرشح المشترك جاهز للتحقق من المشروع.",validation_failed:"لم يجتز الإصدار المرشح المشترك التحقق من المشروع.",conflict:"يحتاج الإصدار المرشح المشترك إلى حل التعارضات.",decision_required:"يحتاج الإصدار المرشح المشترك إلى قرار واحد من مقدم الطلب قبل متابعة الدمج.",published:"تم إعداد الإصدار المشترك محليًا وهو بانتظار المزامنة.",cancelled:"تم إلغاء دمج التعاون.",queued:"لا يزال دمج التعاون في قائمة الانتظار.",failed:"تعذر إكمال دمج التعاون. راجع حالة إعادة المحاولة في المهمة."},
};
Object.assign(translated["zh-CN"],{local_ready:"共享版本已发布。保留本地修改的候选已准备，尚未写入工作空间。",local_conflicts:"共享版本已发布。本地修改存在冲突，解决后才能应用。",local_baseline_required:"共享版本已发布。应用前需要恢复本机上次同步的基线。"});
Object.assign(translated.ar,{local_ready:"تم نشر الإصدار المشترك. الإصدار المحلي المرشح الذي يحافظ على التعديلات الخاصة جاهز، ولم يُطبّق على ملفات مساحة العمل بعد.",local_conflicts:"تم نشر الإصدار المشترك. تحتاج التعديلات المحلية إلى حل التعارضات قبل التطبيق.",local_baseline_required:"تم نشر الإصدار المشترك. يجب استعادة آخر إصدار تمت مزامنته محليًا قبل التطبيق."});
Object.assign(translated["zh-CN"],{local_validation_passed:"共享版本已发布，私有候选已通过本地检查，尚未写入工作空间。",local_validation_failed:"共享版本已发布。私有候选未通过本地检查，尚未写入工作空间。",local_validation_required:"共享版本已发布。私有候选仍需本地检查，之后才能应用。"});
Object.assign(translated.ar,{local_validation_passed:"تم نشر الإصدار المشترك واجتاز المرشح الخاص الفحوص المحلية. لم تُطبّق ملفات مساحة العمل بعد.",local_validation_failed:"تم نشر الإصدار المشترك. لم يجتز المرشح الخاص الفحوص المحلية، ولم تُطبّق ملفات مساحة العمل.",local_validation_required:"تم نشر الإصدار المشترك. لا يزال المرشح الخاص يحتاج إلى فحوص محلية قبل التطبيق."});
translated["zh-CN"].local_applied="共享版本已发布，通过验证的本地候选已写入工作空间。";
translated.ar.local_applied="تم نشر الإصدار المشترك وتطبيق المرشح المحلي الذي اجتاز التحقق على مساحة العمل.";
translated["zh-CN"].local_waiting="共享版本已发布，前台任务空闲后会继续写入本地工作空间。";
translated.ar.local_waiting="تم نشر الإصدار المشترك. سيُستأنف التطبيق المحلي عندما يصبح العمل في المقدمة خاملًا.";
function label(key){
  let locale="en";try{locale=require("../locale-settings").getLocale();}catch{/* Embedded hosts use English. */}
  return translated[locale]?.[key] || descriptions[key] || "Integrate the shared task delivery";
}
function integrationTurnId(value){
  if(!value || Object.keys(value).sort().join(",")!=="accountId,attempt,intentId,sessionId"
    || typeof value.sessionId!=="string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.sessionId) || !Number.isSafeInteger(value.attempt)||value.attempt<0)return null;
  const operation=identity({accountId:value.accountId,intentId:value.intentId});
  if(!operation)return null;
  const key=createHash("sha256").update(JSON.stringify([value.sessionId,operation,value.attempt])).digest("hex");
  return `turn_collaboration_${key}`;
}
async function enqueueIntegrationTurn(orchestrator,value){
  const turnId=integrationTurnId(value);if(!turnId)return {ok:false,error:"COLLAB_INTEGRATION_INVALID"};
  const operation=identity({accountId:value.accountId,intentId:value.intentId});
  const result=await orchestrator.sendUserMessage(value.sessionId,label("start"),[],{
    turnId,durableQueueKey:turnId,queueOrigin:"collaboration",queueVisibility:"background",recordUser:false,
    localAssistant:{collaborationIntegration:operation},
  });
  const snapshot=orchestrator.snapshot?.(value.sessionId);
  return {...result,active:snapshot?.turnId===turnId && snapshot.phase!=="idle"};
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
  const local=result.state==="published"&&["ready","applied","waiting","conflicts","baseline_required"].includes(result.localState)?`local_${result.localState}`:null;
  const localValidation=local==="local_ready"&&["passed","failed","required"].includes(result.localValidationState)?`local_validation_${result.localValidationState}`:null;
  return {assistant:label(localValidation||local||result.state),failed:["validation_failed","failed"].includes(result.state)||localValidation==="local_validation_failed",errorCode:result.state==="validation_failed"?"COLLAB_INTEGRATION_VALIDATION_FAILED":"COLLAB_INTEGRATION_FAILED"};
}
module.exports={enqueueIntegrationTurn,runIntegrationTurn,integrationTurnId};
