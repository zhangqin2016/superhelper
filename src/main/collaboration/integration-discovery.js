"use strict";
const fs=require("node:fs");
const {createHash}=require("node:crypto");
const {createTaskRecords}=require("./task-records");
const {createIntegrationIntents}=require("./integration-intents");

/** Invoked only with a freshly authorized private task snapshot. Discovery is
 * synchronous so its journal and hydration receipt share one SQLite commit.
 * No engine, project selection or filesystem mutation occurs here. */
function createIntegrationDiscovery({store,assertActive,resolveSourceSession}){
  const records=createTaskRecords({store,assertActive}),intents=createIntegrationIntents({store,assertActive});
  return {observe(task){
    assertActive();
    const eligible=task.requesterUserId===store.accountId && task.sharedWorkspaceId && task.inputGit && ["review","accepted"].includes(task.state);
    for(const intent of intents.list(task.conversationId))if(intent.input.taskId===task.id && intent.input.chain==="shared"
      && (!eligible || intent.input.deliveryId!==task.currentDeliveryId))intents.cancel(intent.id);
    if(!eligible)return true;
    const source=records.get(`task:${task.id}`);
    if(!source?.sourceProjectId || !source.sourceSessionId || source.sharedWorkspaceId!==task.sharedWorkspaceId
      || source.gitBaseline?.commit!==task.inputGit.commit || !resolveSourceSession)return false;
    let session;
    try{
      session=resolveSourceSession({projectId:source.sourceProjectId,sessionId:source.sourceSessionId});
      if(!session || session.projectId!==source.sourceProjectId || session.sessionId!==source.sourceSessionId
        || session.rootPath!==source.sourceRoot || fs.realpathSync(source.sourceRoot)!==source.sourceRoot || !fs.statSync(source.sourceRoot).isDirectory())return false;
    }catch(error){if(error.code==="COLLAB_TASK_LOCAL_MISSING" || ["ENOENT","EACCES","ENOTDIR"].includes(error.code))return false;throw error;}
    assertActive();
    const delivery=task.deliveries.find(item=>item.id===task.currentDeliveryId);
    if(!delivery?.git)return false;
    intents.enqueue({conversationId:task.conversationId,workspaceId:task.sharedWorkspaceId,taskId:task.id,deliveryId:delivery.id,
      targetId:createHash("sha256").update(session.rootPath).digest("hex"),chain:"shared",sessionId:session.sessionId,projectId:session.projectId,
      baselineCommit:task.inputGit.commit,deliveryCommit:delivery.git.commit});
    return true;
  }};
}
module.exports={createIntegrationDiscovery};
