"use strict";
const id = v => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v);
const fields = {
  recoveries:[],
  prepare:["projectId"],drafts:[],send:["draftId","assigneeUserId","title","objective","acceptanceCriteria"],
  receive:["taskId"],open:["taskId","deliveryId"],prepareDelivery:["taskId"],submitDelivery:["taskId","draftId"],
  preview:["taskId","deliveryId"],apply:["taskId","deliveryId","applicationId","expectedPlanHash","confirmDeletions"],rollback:["taskId","applicationId"],
};
function taskWorkflowCommand(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(fields,value.operation)
    || (value.operation === "recoveries" ? value.conversationId != null : !id(value.conversationId))) return null;
  const keys = fields[value.operation];
  if (Object.keys(value).some(key=>!["operation","conversationId",...keys].includes(key))) return null;
  for (const key of keys) {
    if (key === "projectId" && !Object.hasOwn(value,key)) continue;
    const v = value[key];
    if (key === "deliveryId" && value.operation === "open" && v == null) continue;
    if (key === "confirmDeletions") { if (typeof v !== "boolean") return null; }
    else if (key === "expectedPlanHash") { if (!/^[a-f0-9]{64}$/.test(v || "")) return null; }
    else if (["title","objective","acceptanceCriteria"].includes(key)) {
      if (typeof v !== "string" || !v.trim() || v.includes("\0") || v.length > (key === "title" ? 200 : 12000)) return null;
    } else if (!id(v)) return null;
  }
  return {...value};
}
// Closed projection: local absolute paths, keys and recovery journals never cross.
function taskWorkflowResult(value) {
  const result = {ok:value?.ok === true};
  for (const key of ["state","code","taskId","draftId","applicationId","projectId","sessionId","clientCommandId","planHash"]) if (id(value?.[key])) result[key] = value[key];
  if (value?.cancelled === true) result.cancelled = true;
  const draft = v => ({id:v.id,name:String(v.name || "").slice(0,200),state:v.state,
    files:(v.files || []).slice(0,10000).map(f=>({path:f.path,sizeBytes:f.sizeBytes})),
    warnings:(v.warnings || []).slice(0,100).map(w=>String(w).slice(0,500)),omitted:v.omitted || 0,
    ...(id(v.taskId)?{taskId:v.taskId}:{}),...(v.input?{input:Object.fromEntries(["assigneeUserId","title","objective","acceptanceCriteria"].map(k=>[k,v.input[k]]))}:{})});
  if (value?.draft) result.draft = draft(value.draft);
  if (Array.isArray(value?.drafts)) result.drafts = value.drafts.map(draft);
  if (Array.isArray(value?.applications)) result.applications = value.applications.map(v=>({
    ...Object.fromEntries(["conversationId","taskId","applicationId","state","deliveryId","planHash"].filter(k=>id(v[k])).map(k=>[k,v[k]])),
    ...(typeof v.label === "string" ? {label:v.label.slice(0,200)} : {}),
  }));
  if (value?.plan) result.plan = {canApply:value.plan.canApply === true,entries:value.plan.entries.map(v=>({path:v.path,operation:v.operation,status:v.status}))};
  return result;
}
module.exports = {taskWorkflowCommand,taskWorkflowResult};
