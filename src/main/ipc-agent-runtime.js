"use strict";

const { ipcMain } = require("electron");
const { ensureSessionRunner, isSessionBusy } = require("./ipc-utils");
const { RuntimeCheckpointService } = require("./runtime-checkpoint-service");
const { checkpointHash } = require("./runtime-checkpoint");
const { emitLifecycle } = require("./task-lifecycle-runtime");

function sessionContext(ctx, sessionId) {
  const session = ctx.sessionManager.findById(sessionId);
  if (!session) return null;
  const project = ctx.projectManager.find(session.projectId);
  if (!project?.path) return null;
  return { session, project };
}

function runtimeEvent(ctx, type, payload) {
  const sessionId = payload.sessionId;
  ctx.eventBus.emit(sessionId, {
    type,
    turnId: payload.turnId || null,
    source: "runtime-checkpoint",
    payload,
  });
}

async function createRuntimeCheckpointForSession(ctx, sessionId, payload = {}) {
  const scoped = sessionContext(ctx, sessionId);
  if (!ctx.runtimeCheckpointService || !scoped) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
  if (isSessionBusy(ctx.runnerPool, sessionId)) throw Object.assign(new Error("BUSY"), { code: "BUSY" });
  const state = ctx.turnOrchestrator?._state?.(sessionId) || {};
  const conversation = [...ctx.sessionManager.getConversation(sessionId)].reverse();
  const latestRecordedTurn = conversation.find((message) => message?.record?.turnId);
  const turnId = String(payload.turnId || state.turnId || state.taskRun?.turnId || latestRecordedTurn?.record?.turnId || "");
  if (!turnId) throw Object.assign(new Error("TURN_REQUIRED"), { code: "TURN_REQUIRED" });
  const turnMessage = conversation.find((message) => String(message?.turnId || message?.record?.turnId || "") === turnId && message?.record);
  const engineMessageId = String(payload.engineMessageId || turnMessage?.record?.engineMessageId || "");
  const filePaths = require("./diff-capture").getDiffsForTurn(sessionId, turnId).map((entry) => entry.filePath);
  const effects = [...(state.tools?.values?.() || [])].map((tool) => {
    const semantics = require("./tool-semantics").resolveToolSemantics(tool);
    return {
      tool: tool.name || "unknown",
      refId: tool.id || `tool:${tool.name || "unknown"}`,
      reversible: false,
      status: semantics.externalSideEffect ? "external_effect_observed" : "local_observation",
      compensationRef: "",
    };
  });
  const runner = ctx.runnerPool.get(sessionId);
  const extraComponents = [];
  if (state.taskRun?.agentGraphId && ctx.agentTaskGraphStore) {
    const graph = ctx.agentTaskGraphStore.get(state.taskRun.agentGraphId, sessionId);
    extraComponents.push({ type: "agent_task_graph", refId: graph.id, version: 1, hash: checkpointHash(graph), reversible: true, payload: graph });
  }
  const checkpoint = await ctx.runtimeCheckpointService.create({
    sessionId,
    turnId,
    taskRunId: state.taskRun?.id || "",
    engineSessionId: runner?.agentResumeId || scoped.session.agentResumeId || "",
    engineMessageId,
    eventSeq: Number(payload.eventSeq || ctx.sessionManager._store().getLastRuntimeEventSeq(sessionId) || 0),
    workspacePath: scoped.project.path,
    filePaths,
    extraComponents,
    effects,
  });
  const lifecycle = ctx.sessionManager.getTaskLifecycle?.(sessionId, turnId);
  if (lifecycle && typeof ctx.sessionManager.transitionTaskLifecycle === "function") {
    const lifecycleResult = ctx.sessionManager.transitionTaskLifecycle(sessionId, {
      taskId: lifecycle.taskId,
      turnId,
      fromStatuses: [lifecycle.status],
      status: lifecycle.status,
      graphId: state.taskRun?.agentGraphId || lifecycle.graphId,
      attemptId: state.taskRun?.resumeState?.leadAttemptId || lifecycle.attemptId,
      checkpointId: checkpoint.id,
      processJobId: lifecycle.processJobId,
    });
    if (lifecycleResult?.ok) emitLifecycle(ctx, sessionId, lifecycleResult.lifecycle);
  }
  return checkpoint;
}

function registerAgentRuntimeHandlers(ctx) {
  const checkpointStore = ctx.runtimeCheckpointStore;
  if (checkpointStore) {
    ctx.runtimeCheckpointService = new RuntimeCheckpointService({
      store: checkpointStore,
      hooks: ctx.publicHookRuntime,
      emit: (type, payload) => runtimeEvent(ctx, type, payload),
      revertEngine: async (sessionId, engineMessageId) => {
        await ensureSessionRunner(ctx, sessionId, { spawn: true });
        return ctx.runnerPool.get(sessionId)?.revert(engineMessageId) || false;
      },
      unrevertEngine: async (sessionId) => ctx.runnerPool.get(sessionId)?.unrevert() || false,
      rewindSession: async (sessionId, turnId) => ctx.sessionManager.deleteMessagesFromTurn(sessionId, turnId),
      createForkSession: async ({ sourceSessionId, checkpoint, title }) => {
        const source = ctx.sessionManager.findById(sourceSessionId);
        if (!source) throw new Error("SESSION_NOT_FOUND");
        if (!checkpoint?.turnId || !checkpoint?.engineMessageId) throw new Error("CHECKPOINT_FORK_BOUNDARY_REQUIRED");
        const forked = ctx.sessionManager.forkAtTurn(
          sourceSessionId,
          title || `${source.title || "Session"} (fork)`,
          checkpoint.turnId,
        );
        try {
          await ensureSessionRunner(ctx, sourceSessionId, { spawn: true });
          const nativeFork = await ctx.runnerPool.get(sourceSessionId)?.fork(checkpoint.engineMessageId);
          const resumeId = String(nativeFork?.id || nativeFork?.sessionID || nativeFork?.sessionId || "").trim();
          if (!resumeId) throw new Error("OPENCODE_FORK_FAILED");
          const claim = ctx.turnOrchestrator?._claimAgentResumeId?.(forked.id, resumeId);
          if (!claim?.ok) throw new Error("OPENCODE_FORK_BINDING_FAILED");
          return ctx.sessionManager.findById(forked.id);
        } catch (error) {
          ctx.sessionManager.deleteById(forked.id);
          throw error;
        }
      },
      captureComponent: async (component, input) => {
        if (component.type !== "agent_task_graph") throw new Error("RUNTIME_CHECKPOINT_ADAPTER_UNAVAILABLE");
        const payload = ctx.agentTaskGraphStore.get(component.refId, input.sessionId);
        return { type: component.type, refId: component.refId, version: 1, hash: checkpointHash(payload), reversible: true, payload };
      },
      restoreComponent: async (component, input) => {
        if (component.type !== "agent_task_graph") throw new Error("RUNTIME_CHECKPOINT_ADAPTER_UNAVAILABLE");
        return ctx.agentTaskGraphStore.restoreSnapshot(component.refId, input.sessionId, component.payload);
      },
    });
  }

  ipcMain.handle("agent-runtime:graph-get", (_event, payload = {}) => {
    const sessionId = String(payload.sessionId || "");
    const graphId = String(payload.graphId || "");
    if (!ctx.agentTaskGraphStore || !sessionContext(ctx, sessionId)) return { ok: false, error: "NOT_FOUND" };
    try { return { ok: true, graph: ctx.agentTaskGraphStore.get(graphId, sessionId) }; }
    catch (err) { return { ok: false, error: err?.code || "AGENT_GRAPH_FAILED" }; }
  });

  ipcMain.handle("agent-runtime:hook-list", (_event, payload = {}) => {
    const sessionId = String(payload.sessionId || "");
    if (sessionId && !sessionContext(ctx, sessionId)) return { ok: false, error: "NOT_FOUND" };
    return {
      ok: true,
      hooks: ctx.publicHookRuntime?.list?.() || [],
      audits: sessionId ? ctx.publicHookAuditStore?.list?.(sessionId, payload.limit) || [] : [],
    };
  });

  ipcMain.handle("agent-runtime:hook-upsert", (_event, payload = {}) => {
    if (!ctx.publicHookRuntime || !ctx.publicHookConfigStore) return { ok: false, error: "PUBLIC_HOOKS_UNAVAILABLE" };
    const input = payload.hook || {};
    const previous = ctx.publicHookRuntime.list().find((hook) => hook.id === String(input.id || "")) || null;
    if (previous) ctx.publicHookRuntime.unregister(previous.id);
    try {
      const hook = ctx.publicHookRuntime.register(input);
      ctx.publicHookConfigStore.upsert(hook);
      return { ok: true, hook };
    } catch (err) {
      if (previous) ctx.publicHookRuntime.register(previous);
      return { ok: false, error: err?.code || "PUBLIC_HOOK_INVALID", detail: String(err?.message || err) };
    }
  });

  ipcMain.handle("agent-runtime:hook-remove", (_event, payload = {}) => {
    const id = String(payload.id || "");
    const runtimeRemoved = ctx.publicHookRuntime?.unregister?.(id) || false;
    const configRemoved = ctx.publicHookConfigStore?.remove?.(id) || false;
    return { ok: true, removed: runtimeRemoved || configRemoved };
  });

  ipcMain.handle("agent-runtime:task-cancel", (_event, payload = {}) => {
    const sessionId = String(payload.sessionId || "");
    if (!ctx.agentTaskGraphStore || !sessionContext(ctx, sessionId)) return { ok: false, error: "NOT_FOUND" };
    try {
      const changed = ctx.agentTaskGraphStore.cancel({
        graphId: String(payload.graphId || ""),
        sessionId,
        taskId: String(payload.taskId || ""),
        reason: String(payload.reason || "cancelled_by_user"),
      });
      return { ok: true, changed };
    } catch (err) { return { ok: false, error: err?.code || "AGENT_TASK_CANCEL_FAILED" }; }
  });

  ipcMain.handle("agent-runtime:checkpoint-list", (_event, payload = {}) => {
    const sessionId = String(payload.sessionId || "");
    if (!checkpointStore || !sessionContext(ctx, sessionId)) return { ok: false, error: "NOT_FOUND" };
    try { return { ok: true, checkpoints: checkpointStore.list(sessionId, { limit: payload.limit }) }; }
    catch (err) { return { ok: false, error: err?.code || "RUNTIME_CHECKPOINT_LIST_FAILED" }; }
  });

  ipcMain.handle("agent-runtime:checkpoint-create", async (_event, payload = {}) => {
    const sessionId = String(payload.sessionId || "");
    try {
      const checkpoint = await createRuntimeCheckpointForSession(ctx, sessionId, payload);
      return { ok: true, checkpoint };
    } catch (err) { return { ok: false, error: err?.code || "RUNTIME_CHECKPOINT_CREATE_FAILED", detail: String(err?.message || err) }; }
  });

  ipcMain.handle("agent-runtime:checkpoint-restore", async (_event, payload = {}) => {
    const sessionId = String(payload.sessionId || "");
    const scoped = sessionContext(ctx, sessionId);
    if (!ctx.runtimeCheckpointService || !scoped) return { ok: false, error: "NOT_FOUND" };
    if (isSessionBusy(ctx.runnerPool, sessionId)) return { ok: false, error: "BUSY" };
    try {
      const result = await ctx.runtimeCheckpointService.restore({
        checkpointId: String(payload.checkpointId || ""),
        sessionId,
        workspacePath: scoped.project.path,
      });
      return { ok: true, result };
    } catch (err) { return { ok: false, error: err?.code || "RUNTIME_CHECKPOINT_RESTORE_FAILED", detail: String(err?.message || err) }; }
  });

  ipcMain.handle("agent-runtime:checkpoint-fork", async (_event, payload = {}) => {
    const sessionId = String(payload.sessionId || "");
    if (!ctx.runtimeCheckpointService || !sessionContext(ctx, sessionId)) return { ok: false, error: "NOT_FOUND" };
    try {
      const result = await ctx.runtimeCheckpointService.fork({
        checkpointId: String(payload.checkpointId || ""),
        sessionId,
        title: String(payload.title || ""),
      });
      return { ok: true, result };
    } catch (err) { return { ok: false, error: err?.code || "RUNTIME_CHECKPOINT_FORK_FAILED", detail: String(err?.message || err) }; }
  });
}

module.exports = { createRuntimeCheckpointForSession, registerAgentRuntimeHandlers };
