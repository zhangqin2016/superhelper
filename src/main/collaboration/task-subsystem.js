"use strict";

/**
 * Everything a collaboration task needs, assembled in one place.
 *
 * The service used to wire seven collaborators inline — commands, hydration,
 * history, workflow, integration discovery/worker/admission — each guarded by a
 * different corner of the rollout policy. Read in the middle of the service's
 * own concerns (sync lanes, realtime, presence) it was impossible to see which
 * pieces a given policy actually produces, and every new task capability made
 * the service longer. Here the policy gates sit next to each other:
 *
 *   tasks / hydration / history   always constructed; the service decides when
 *                                 to call them (taskOperation checks policy)
 *   integrationDiscovery          taskGitProtocol 1 AND a source-session resolver
 *   integrationWorker             discovery AND a workspace root
 *   integrationAdmission          worker AND a turn enqueuer
 *
 * Each `null` is a capability the host cannot support, and every consumer
 * already treats null as "not available" — so a missing gate degrades to the
 * pre-integration behaviour rather than failing a task.
 */
function createTaskSubsystem({
  store, client, deviceId, assertActive, policy, taskOptions, transfers,
  emitState, enqueueSync, isConversationRevoked, queueAuthorizedRefresh,
  recoverConversationHydration, recoverDeniedHistory,
  createTaskCommands, createTaskHydration, createTaskHistory,
}) {
  const tasks = createTaskCommands({ store, client, deviceId, assertActive, onChange: () => emitState("task") });
  const integrationDiscovery=policy?.taskGitProtocol===1 && taskOptions.resolveSourceSession
    ? require("./integration-discovery").createIntegrationDiscovery({store,assertActive,resolveSourceSession:taskOptions.resolveSourceSession}) : null;
  const onTask=integrationDiscovery ? task=>integrationDiscovery.observe(task) : undefined;
  const taskHydration=createTaskHydration({store,client,deviceId,assertActive,onChange:()=>emitState("task"),
    onTask,
    ensureConversation:async conversationId=>{
      await enqueueSync(async()=>{
        assertActive();
        if(isConversationRevoked(store,conversationId))throw Object.assign(new Error("Access revoked"),{code:"COLLAB_ACCESS_REVOKED"});
        queueAuthorizedRefresh(store,conversationId);
        await recoverConversationHydration({store,client,deviceId,assertActive,recoverDeniedHistory});
      });
    }});
  const taskHistory=createTaskHistory({store,client,deviceId,protocol:policy?.taskHistoryProtocol,assertActive,onChange:()=>emitState("task"),onTask});
  const recoverTasks=()=>policy?.enabled===true&&policy?.tasks===true&&policy?.workspaceShares===true
    ? Promise.all([taskHydration.recover(),taskHistory.recover(),(integrationAdmission || integrationWorker)?.recover()]) : Promise.resolve();
  let workflow;
  const getWorkflow = () => workflow ||= require("./task-workflow").createTaskWorkflow({...taskOptions,store,client,tasks,transfers,deviceId,assertActive,sharedWorkspaceProtocol:policy?.sharedWorkspaceProtocol,taskGitProtocol:policy?.taskGitProtocol,sharedPublicationProtocol:policy?.sharedPublicationProtocol,
    integrationValidationAvailable:typeof taskOptions.validateIntegration==="function" && typeof taskOptions.validationPolicyId==="string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(taskOptions.validationPolicyId),onChange:()=>emitState("task")});
  const integrationWorker=integrationDiscovery && taskOptions.rootPath
    ? require("./integration-worker").createIntegrationWorker({store,assertActive,getWorkflow,validateIntegration:taskOptions.validateIntegration,
      validationPolicyId:taskOptions.validationPolicyId,remotePublicationEnabled:policy?.sharedPublicationProtocol===1,onChange:()=>emitState("task")}) : null;
  const integrationAdmission=integrationWorker && typeof taskOptions.enqueueIntegrationTurn==="function"
    ? require("./integration-admission").createIntegrationAdmission({store,assertActive,getWorkflow,worker:integrationWorker,
      enqueue:taskOptions.enqueueIntegrationTurn,onChange:()=>emitState("task")}) : null;

  return { tasks, taskHydration, taskHistory, recoverTasks, getWorkflow, integrationDiscovery, integrationWorker, integrationAdmission };
}

module.exports = { createTaskSubsystem };
