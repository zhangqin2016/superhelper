"use strict";

const { getLogger } = require("./logger");
const {
  bindTaskAdmission,
  captureContextSnapshot,
  compareContextSources,
  createTaskCoreEnvelope,
} = require("./task-core-contracts");
const { ensureTaskLifecycle, transitionTaskLifecycle } = require("./task-lifecycle-runtime");
const { registryId } = require("./store/task-context-registry-store");

const log = getLogger("task-core-runtime");

function persistTaskCoreEnvelope(orchestrator, session, state, options = {}) {
  const candidateContextRegistryId = registryId({
    sessionId: session.id,
    ownerScope: state.taskAdmission?.ownerScope || "",
    taskId: state.contextSnapshot?.taskId || state.taskRun?.id || state.turnId,
    turnId: state.turnId,
    sourceFingerprint: state.contextSnapshot?.sourceFingerprint || "",
  });
  if (typeof orchestrator.ctx.sessionManager?.persistTaskContextSnapshot === "function") {
    let registered = null;
    try {
      registered = orchestrator.ctx.sessionManager.persistTaskContextSnapshot(session.id, {
        registryId: candidateContextRegistryId,
        taskId: state.contextSnapshot?.taskId || state.taskRun?.id || state.turnId,
        turnId: state.turnId,
        snapshot: state.contextSnapshot,
        now: state.startedAt || Date.now(),
      });
    } catch (error) {
      log.warn("task context registry threw; continuing with in-memory snapshot: session=%s turn=%s error=%s", session.id, state.turnId, error?.message || error);
    }
    if (!registered?.ok) {
      log.warn("task context registry unavailable; continuing with in-memory snapshot: session=%s turn=%s reason=%s", session.id, state.turnId, registered?.reason || "unknown");
      state.contextRegistryId = "";
    } else {
      state.contextRegistryId = candidateContextRegistryId;
    }
  }
  let taskCore;
  try {
    taskCore = createTaskCoreEnvelope({
      sessionId: session.id,
      projectId: options.projectId || session.projectId,
      admission: state.taskAdmission,
      contextSnapshot: state.contextSnapshot,
      taskContract: options.taskContract || state.taskContract,
      files: options.files || state.currentPayload?.files || [],
      sourceTaskCore: options.sourceTaskCore || null,
      recoveryContext: options.recoveryContext || null,
      contextRegistryId: state.contextRegistryId || "",
    });
  } catch (error) {
    log.error("task core envelope build failed: %s", error?.message || error);
    return { ok: false, reason: "TASK_CORE_BUILD_FAILED", error };
  }
  state.taskCore = taskCore;
  transitionTaskLifecycle(orchestrator.ctx, session.id, state, "running", {
    taskCoreFingerprint: taskCore.fingerprint,
    graphId: state.taskRun?.agentGraphId || "",
    attemptId: state.dispatchAttemptId || state.taskRun?.resumeState?.leadAttemptId || "",
    metadata: {
      taskRunId: state.taskRun?.id || "",
      taskCoreTaskId: taskCore.taskId || "",
    },
  });
  const persist = orchestrator.ctx.sessionManager?.persistTurnTaskCore;
  if (typeof persist !== "function") return { ok: true, legacy: true, taskCore };
  const result = persist.call(orchestrator.ctx.sessionManager, session.id, state.turnId, taskCore);
  if (!result?.ok) {
    log.error("task core persistence failed: session=%s turn=%s reason=%s", session.id, state.turnId, result?.reason || "unknown");
    return { ok: false, reason: result?.reason || "TASK_CORE_PERSIST_FAILED", taskCore };
  }
  return { ok: true, taskCore };
}

function captureAndPersistTaskCore(orchestrator, session, state, options = {}) {
  captureContextSnapshot(state, session.id, options);
  const recoveryContext = compareContextSources(options.sourceTaskCore, state.contextSnapshot);
  if (options.sourceTaskCore && state.enginePayload?.trace) {
    state.enginePayload.trace.recoveryContext = recoveryContext;
  }
  const result = persistTaskCoreEnvelope(orchestrator, session, state, { ...options, recoveryContext });
  if (!result.ok) {
    orchestrator._finalize(session.id, "turn.failed", {
      failed: true,
      assistant: "任务上下文保存失败，未开始执行。请重试。",
      code: result.reason,
      errorCode: result.reason,
    });
    return { ...result, result: { ok: false, error: result.reason } };
  }
  return result;
}

function bindTurnAdmission(orchestrator, session, state, admitted, delivery) {
  state.admittedSeq = admitted?.admittedSeq || null;
  state.admittedTurnInput = admitted || null;
  // The lifecycle row is admitted before intent recognition may create a
  // taskRun. Keep one immutable identity for the whole turn and link the
  // later taskRun id through lifecycle metadata.
  state.lifecycleTaskId = String(admitted?.taskRunId || admitted?.turnId || state.turnId || "");
  bindTaskAdmission(state, session.id, admitted);
  require("./public-hooks").observePublicHook(orchestrator.ctx.publicHookRuntime, "turn.admitted", {
    sessionId: session.id,
    turnId: state.turnId,
    principalId: admitted?.ownerScope || "",
    delivery: admitted?.delivery || delivery,
  });
  state.characterWorldsSnapshot = require("./character-worlds/turn-binding-snapshot").snapshotFromMetadata(admitted?.metadata);
  state.characterWorldsRuntimeSnapshot = null;
  ensureTaskLifecycle(orchestrator.ctx, session.id, state, {
    status: "admitted",
    taskCoreFingerprint: "",
    graphId: state.taskRun?.agentGraphId || "",
    attemptId: state.dispatchAttemptId || state.taskRun?.resumeState?.leadAttemptId || "",
    metadata: {
      delivery,
      scheduledTaskRunId: admitted?.scheduledTaskRunId || null,
      externalCommandId: admitted?.externalCommandId || null,
    },
  });
}

function trustedSourceTaskCore(sessionId, ownerScope, source) {
  if (!source || typeof source !== "object") return null;
  if (source.sessionId !== sessionId) return null;
  if (source.ownerScope && source.ownerScope !== ownerScope) return null;
  return source;
}

module.exports = { bindTurnAdmission, captureAndPersistTaskCore, persistTaskCoreEnvelope, trustedSourceTaskCore };
