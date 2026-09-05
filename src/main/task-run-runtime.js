"use strict";

const { getLogger } = require("./logger");
const {
  addTaskEvidence,
  addTaskRisk,
  applyTaskPlanFromTodos,
  observePlanTool: observePlanToolState,
  reconcilePlanAtTurnEnd,
  assessTaskVerification,
  compactTaskRun,
  completeTaskRun,
  createTaskRun,
  markTaskPhase,
  noteTaskToolUse,
  updateTaskLiveness,
} = require("./task-run-state");

const log = getLogger("task-run-runtime");
const { syncAgentTaskFromTool } = require("./agent-task-projection");
const {
  transitionTaskLifecycle,
  verificationLifecycleStatus,
} = require("./task-lifecycle-runtime");

function progressValueFromNotice(notice = {}) {
  const progress = notice?.progress;
  if (!progress || typeof progress !== "object") return null;
  const explicit = Number(progress.percent ?? progress.value);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(100, explicit));
  const current = Number(progress.current ?? progress.done ?? progress.writtenBytes ?? progress.currentBytes);
  const total = Number(progress.total ?? progress.max ?? progress.totalBytes);
  if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(100, (current / total) * 100));
  }
  return null;
}

function shouldBeginTaskRunAtTurnStart({ taskContract = null, turnPolicy = null, scheduledTask = null } = {}) {
  if (scheduledTask?.runId) return true;
  if (taskContract?.active) return true;
  return Boolean(turnPolicy && turnPolicy.rigor && turnPolicy.rigor !== "fast");
}

function compactTool(tool = null) {
  if (!tool) return null;
  return {
    id: tool.id || "",
    name: tool.name || "unknown",
    status: tool.status || "",
    title: tool.title || "",
  };
}

function createTaskRunRuntime(options = {}) {
  const ctx = options.ctx || null;
  const getState = options.getState;
  const emitEvent = options.emitEvent || (() => []);
  const now = options.now || (() => Date.now());
  const agentTaskGraphStore = options.agentTaskGraphStore || null;
  const publicHookRuntime = options.publicHookRuntime || null;

  function stateFor(sessionId) {
    if (typeof getState !== "function") throw new Error("getState adapter is required");
    return getState(sessionId);
  }

  function renewLeadLease(sessionId, state) {
    const graphId = state.taskRun?.agentGraphId;
    const attemptId = state.taskRun?.resumeState?.leadAttemptId;
    if (!agentTaskGraphStore || !graphId || !attemptId) return;
    try {
      agentTaskGraphStore.renew({
        graphId,
        sessionId,
        taskId: `lead_${state.taskRun.id}`,
        workerId: "lead",
        attemptId,
        now: now(),
        leaseMs: 24 * 60 * 60 * 1_000,
      });
    } catch (error) {
      if (!/AGENT_TASK_(NOT_RUNNING|LEASE_EXPIRED)/.test(String(error?.code || error?.message || ""))) {
        log.warn("Lead agent lease renewal failed open: %s", error?.message || error);
      }
    }
  }

  function emitTaskEvent(sessionId, type, payload = {}) {
    try {
      const state = stateFor(sessionId);
      if (!state.turnId) return null;
      renewLeadLease(sessionId, state);
      const emitted = emitEvent(sessionId, {
        type,
        turnId: state.turnId,
        source: "task-run",
        payload,
      })?.[0] || null;
      if (["agent.spawned", "agent.started", "agent.waiting", "agent.completed"].includes(type)) {
        require("./public-hooks").observePublicHook(publicHookRuntime, type, { sessionId, turnId: state.turnId, ...payload });
      }
      return emitted;
    } catch (err) {
      log.warn("TaskRun event dropped (%s): %s", type, err?.message || err);
      return null;
    }
  }

  function begin(sessionId, objective, opts = {}) {
    try {
      const state = stateFor(sessionId);
      if (state.taskRun) return state.taskRun;
      if (!state.turnId) return null;
      state.taskRun = createTaskRun({
        sessionId,
        turnId: state.turnId,
        objective,
        intentContract: opts.intentContract || state.taskContract?.intentContract || null,
        startedAt: state.startedAt || now(),
      });
      if (opts.scheduledTask) {
        state.taskRun.resumeState = {
          ...(state.taskRun.resumeState || {}),
          scheduledTaskId: opts.scheduledTask.id || "",
          scheduledTaskRunId: opts.scheduledTask.runId || "",
        };
      }
      if (opts.localAssistant) {
        markTaskPhase(state.taskRun, "local_assistant", "Preparing local assistant response");
      }
      if (agentTaskGraphStore && process.env.LILY_AGENT_TASK_GRAPH !== "0") {
        try {
          const { addAgentTask, createAgentTaskGraph } = require("./agent-task-graph");
          const graph = createAgentTaskGraph({
            taskRunId: state.taskRun.id,
            sessionId,
            principalId: state.admittedTurnInput?.ownerScope || opts.principalId || `session:${sessionId}`,
            now: state.startedAt || now(),
          });
          addAgentTask(graph, {
            id: `lead_${state.taskRun.id}`,
            agentId: "lead",
            depth: 0,
            objective: state.taskRun.objective || objective || "Execute task",
            replaySafe: false,
            maxAttempts: 1,
            now: state.startedAt || now(),
          });
          const leadClaim = require("./agent-task-graph").claimAgentTask(graph, `lead_${state.taskRun.id}`, {
            workerId: "lead",
            leaseMs: 24 * 60 * 60 * 1_000,
            now: state.startedAt || now(),
          });
          agentTaskGraphStore.create(graph);
          state.taskRun.agentGraphId = graph.id;
          state.taskRun.resumeState = { ...(state.taskRun.resumeState || {}), leadAttemptId: leadClaim?.attemptId || "" };
          emitTaskEvent(sessionId, "agent.graph.created", {
            taskRunId: state.taskRun.id,
            graphId: graph.id,
            leadTaskId: `lead_${state.taskRun.id}`,
          });
        } catch (err) {
          log.warn("Agent task graph projection failed open: %s", err?.message || err);
        }
      }
      emitTaskEvent(sessionId, "task.created", {
        taskRun: compactTaskRun(state.taskRun),
      });
      emitTaskEvent(sessionId, "task.plan.updated", {
        taskRunId: state.taskRun.id,
        plan: state.taskRun.plan,
        activeStep: state.taskRun.activeStep,
      });
      return state.taskRun;
    } catch (err) {
      log.warn("TaskRun begin failed: %s", err?.message || err);
      return null;
    }
  }

  function ensure(sessionId, reason = "runtime_event") {
    try {
      const state = stateFor(sessionId);
      if (state.taskRun) return state.taskRun;
      if (!state.turnId) return null;
      const payload = state.currentPayload || {};
      const taskRun = begin(sessionId, payload.rawText || payload.text || "", {
        displayFiles: payload.displayFiles || [],
        scheduledTask: state.scheduledTask || null,
      });
      if (taskRun) {
        taskRun.resumeState = {
          ...(taskRun.resumeState || {}),
          createdBy: reason,
        };
      }
      return taskRun;
    } catch (err) {
      log.warn("TaskRun ensure failed: %s", err?.message || err);
      return null;
    }
  }

  function markProgress(sessionId, phase, label, opts = {}) {
    try {
      const state = stateFor(sessionId);
      if (!state.taskRun) ensure(sessionId, "tool_or_progress");
      if (!state.taskRun) return null;
      if (opts.tool) noteTaskToolUse(state.taskRun, opts.tool);
      if (opts.tool) syncAgentTaskFromTool({ store: agentTaskGraphStore, state, sessionId, tool: opts.tool, now: now(), emit: (type, payload) => emitTaskEvent(sessionId, type, payload) });
      markTaskPhase(state.taskRun, phase, label, {
        resumeState: opts.resumeState || null,
      });
      if (opts.resumeState?.processJobId) {
        transitionTaskLifecycle(ctx, sessionId, state, "running", {
          processJobId: opts.resumeState.processJobId,
        });
      }
      emitTaskEvent(sessionId, "task.step.progress", {
        taskRunId: state.taskRun.id,
        phase: state.taskRun.phase,
        activeStep: state.taskRun.activeStep,
        progress: state.taskRun.progress,
        tool: compactTool(opts.tool),
        taskRun: compactTaskRun(state.taskRun),
      });
      return state.taskRun;
    } catch (err) {
      log.warn("TaskRun progress failed: %s", err?.message || err);
      return null;
    }
  }

  function markAwaitingUser(sessionId, code, message) {
    try {
      const state = stateFor(sessionId);
      if (!state.taskRun) ensure(sessionId, "awaiting_user");
      if (!state.taskRun) return null;
      markTaskPhase(state.taskRun, "awaiting_user", message, { status: "awaiting_user" });
      transitionTaskLifecycle(ctx, sessionId, state, "waiting_user");
      const risk = addTaskRisk(state.taskRun, {
        code,
        level: "info",
        message,
      });
      emitTaskEvent(sessionId, "task.risk.detected", {
        taskRunId: state.taskRun.id,
        risk,
        taskRun: compactTaskRun(state.taskRun),
      });
      return risk;
    } catch (err) {
      log.warn("TaskRun awaiting-user mark failed: %s", err?.message || err);
      return null;
    }
  }

  function addEvidence(sessionId, evidence, opts = {}) {
    try {
      const state = stateFor(sessionId);
      if (!state.taskRun && opts.tool) ensure(sessionId, "tool_evidence");
      if (!state.taskRun) return null;
      const item = addTaskEvidence(state.taskRun, evidence);
      if (opts.tool) observePlanTool(sessionId, opts.tool, { running: false });
      if (opts.tool) syncAgentTaskFromTool({ store: agentTaskGraphStore, state, sessionId, tool: opts.tool, now: now(), emit: (type, payload) => emitTaskEvent(sessionId, type, payload) });
      emitTaskEvent(sessionId, "task.evidence.added", {
        taskRunId: state.taskRun.id,
        evidence: item,
        tool: compactTool(opts.tool),
        taskRun: compactTaskRun(state.taskRun),
      });
      return item;
    } catch (err) {
      log.warn("TaskRun evidence failed: %s", err?.message || err);
      return null;
    }
  }

  /** Feed a tool observation into the plan-progress overlay (see
   *  task-run-state.observePlanTool). Emits task.plan.updated only when a step's
   *  overlay actually changed, so idle tool traffic costs no renderer work. */
  function observePlanTool(sessionId, tool, opts = {}) {
    try {
      const state = stateFor(sessionId);
      if (!state.taskRun) return null;
      const changed = observePlanToolState(state.taskRun, tool, opts);
      if (changed) emitPlanUpdated(sessionId, state);
      return state.taskRun;
    } catch (err) {
      log.warn("TaskRun plan observation failed open: %s", err?.message || err);
      return null;
    }
  }

  function emitPlanUpdated(sessionId, state) {
    emitTaskEvent(sessionId, "task.plan.updated", {
      taskRunId: state.taskRun.id,
      plan: state.taskRun.plan,
      activeStep: state.taskRun.activeStep,
      taskRun: compactTaskRun(state.taskRun),
    });
  }

  /** End-of-turn plan reconciliation, BEFORE complete(): deterministic pass
   *  always; the model pass only when the deterministic one left a stale item
   *  undecided (see todo-plan-reconciler). Bounded by its own timeout and
   *  fail-open — the turn seals with whatever overlay exists. */
  function reconcilePlan(sessionId, terminalType = "turn.completed") {
    try {
      const state = stateFor(sessionId);
      if (!state.taskRun) return null;
      const changed = reconcilePlanAtTurnEnd(state.taskRun, terminalType);
      // Synchronous unless a model pass is warranted: interrupt/fail paths must
      // finalize in the same tick they always did (no new await in that path).
      const reconciler = terminalType === "turn.completed" ? require("./todo-plan-reconciler") : null;
      if (!reconciler || !reconciler.shouldReconcileWithModel(state.taskRun).ok) {
        if (changed) emitPlanUpdated(sessionId, state);
        return state.taskRun;
      }
      return reconciler.reconcilePlanWithModel({ taskRun: state.taskRun })
        .then((result) => {
          if (changed || result?.applied) emitPlanUpdated(sessionId, state);
          return state.taskRun;
        })
        .catch((err) => {
          log.warn("TaskRun model plan reconciliation failed open: %s", err?.message || err);
          if (changed) emitPlanUpdated(sessionId, state);
          return state.taskRun;
        });
    } catch (err) {
      log.warn("TaskRun plan reconciliation failed open: %s", err?.message || err);
      return null;
    }
  }

  function updatePlanFromTodos(sessionId, todos = []) {
    try {
      const state = stateFor(sessionId);
      if (!state.taskRun) ensure(sessionId, "todo_updated");
      if (!state.taskRun) return null;
      const before = JSON.stringify(state.taskRun.plan || []);
      applyTaskPlanFromTodos(state.taskRun, todos);
      const after = JSON.stringify(state.taskRun.plan || []);
      if (after === before) return state.taskRun;
      emitTaskEvent(sessionId, "task.plan.updated", {
        taskRunId: state.taskRun.id,
        plan: state.taskRun.plan,
        activeStep: state.taskRun.activeStep,
        taskRun: compactTaskRun(state.taskRun),
      });
      return state.taskRun;
    } catch (err) {
      log.warn("TaskRun plan fusion failed: %s", err?.message || err);
      return null;
    }
  }

  function updateLivenessFromNotice(sessionId, notice = {}, eventType = "engine.notice") {
    try {
      const state = stateFor(sessionId);
      if (!notice) return null;
      const code = String(notice.code || "").trim();
      const detail = String(notice.detail || notice.message || "").trim();
      let status = "runtime_notice";
      let phase = "";
      let countsAsActivity = false;
      if (code === "longWait" || code === "waitingForFirstResponse") {
        status = "no_visible_progress";
        phase = "waiting";
      } else if (code === "toolProgress" || code === "shellLongRunning") {
        status = "tool_running";
        phase = "tool_running";
      } else if (code === "workProgress") {
        status = "work_running";
        phase = "work_running";
        countsAsActivity = true;
      } else if (eventType === "engine.warning" || notice.level === "warning") {
        status = "warning";
      } else if (notice.level === "progress") {
        status = "running";
      }
      if (!state.taskRun) return null;
      const ts = now();
      const livenessSig = `${status}\0${code}\0${detail}`;
      const previousLiveness = state.taskRun._lastLivenessEmit || null;
      if (
        previousLiveness?.sig === livenessSig &&
        Number.isFinite(previousLiveness.ts) &&
        ts - previousLiveness.ts < 750
      ) return state.taskRun.liveness || null;

      state.taskRun._lastLivenessEmit = { sig: livenessSig, ts };
      const liveness = updateTaskLiveness(state.taskRun, {
        status,
        detail,
        noticeCode: code,
        countsAsActivity,
      });
      if (phase && detail) {
        state.taskRun.phase = phase;
        state.taskRun.progress = {
          label: detail,
          value: progressValueFromNotice(notice),
        };
        state.taskRun.resumeState = {
          ...(state.taskRun.resumeState || {}),
          lastLivenessCode: code,
        };
      }
      emitTaskEvent(sessionId, "task.liveness.updated", {
        taskRunId: state.taskRun.id,
        liveness,
        notice: {
          code,
          level: notice.level || "",
          detail,
          progress: notice.progress && typeof notice.progress === "object" ? notice.progress : null,
        },
        taskRun: compactTaskRun(state.taskRun),
      });
      if (status === "no_visible_progress") {
        const risk = addTaskRisk(state.taskRun, {
          code: "NO_VISIBLE_PROGRESS",
          level: "info",
          message: detail || "NO_VISIBLE_PROGRESS",
        });
        emitTaskEvent(sessionId, "task.risk.detected", {
          taskRunId: state.taskRun.id,
          risk,
          taskRun: compactTaskRun(state.taskRun),
        });
      } else if (status === "warning") {
        const risk = addTaskRisk(state.taskRun, {
          code: code || "ENGINE_WARNING",
          level: "warning",
          message: detail || code || "ENGINE_WARNING",
        });
        emitTaskEvent(sessionId, "task.risk.detected", {
          taskRunId: state.taskRun.id,
          risk,
          taskRun: compactTaskRun(state.taskRun),
        });
      }
      return liveness;
    } catch (err) {
      log.warn("TaskRun liveness update failed: %s", err?.message || err);
      return null;
    }
  }

  function complete(sessionId, terminalType, opts = {}) {
    try {
      const state = stateFor(sessionId);
      if (!state.taskRun) return null;
      if (terminalType === "turn.completed") {
        transitionTaskLifecycle(ctx, sessionId, state, "verifying");
      }
      const verification = terminalType === "turn.completed"
        ? assessTaskVerification({
            taskType: state.turnPolicy?.taskType || state.taskContract?.taskType || "",
            evidence: state.taskRun.evidence || [],
            evidenceGateAssessment: opts.evidenceGateAssessment || null,
            evidenceSummary: opts.evidenceSummary || null,
            successCriteria: state.taskRun.successCriteria || [],
            deliverables: state.taskRun.deliverables || [],
            fileChangeCount: opts.fileChangeCount || 0,
            artifactCount: opts.artifactCount || 0,
          })
        : { status: "not_verified", reason: "" };
      completeTaskRun(state.taskRun, terminalType, verification);
      if (terminalType === "turn.completed") {
        transitionTaskLifecycle(ctx, sessionId, state, verificationLifecycleStatus(verification), {
          verification,
          graphId: state.taskRun.agentGraphId || "",
          attemptId: state.taskRun.resumeState?.leadAttemptId || "",
        });
      } else if (opts.outcomeUnknown === true || terminalType === "turn.stalled") {
        transitionTaskLifecycle(ctx, sessionId, state, "outcome_unknown", {
          metadata: { terminalType, reason: opts.outcomeUnknown ? "dispatch_outcome_unknown" : "stalled" },
        });
      } else if (terminalType === "turn.interrupted") {
        transitionTaskLifecycle(ctx, sessionId, state, "cancelled", {
          metadata: { terminalType },
        });
      } else {
        transitionTaskLifecycle(ctx, sessionId, state, "failed", {
          metadata: { terminalType },
        });
      }
      if (agentTaskGraphStore && state.taskRun.agentGraphId) {
        const graph = agentTaskGraphStore.get(state.taskRun.agentGraphId, sessionId);
        const lead = graph.tasks[`lead_${state.taskRun.id}`];
        if (lead?.status === "running") {
          const input = { graphId: graph.id, sessionId, taskId: lead.id, workerId: lead.workerId, attemptId: lead.activeAttemptId, now: now() };
          if (terminalType === "turn.completed") agentTaskGraphStore.complete({ ...input, handoff: state.taskRun.completionStatus || "completed" });
          else agentTaskGraphStore.fail({ ...input, error: terminalType });
        }
      }
      const eventType = terminalType === "turn.failed"
        ? "task.failed"
        : terminalType === "turn.interrupted"
          ? "task.interrupted"
          : terminalType === "turn.stalled"
            ? "task.stalled"
            : "task.completed";
      emitTaskEvent(sessionId, eventType, {
        taskRunId: state.taskRun.id,
        status: state.taskRun.status,
        completionStatus: state.taskRun.completionStatus,
        verification: state.taskRun.verification,
        evidenceSummary: opts.evidenceSummary || null,
        taskRun: compactTaskRun(state.taskRun),
      });
      return state.taskRun;
    } catch (err) {
      log.warn("TaskRun completion failed: %s", err?.message || err);
      return null;
    }
  }

  return {
    addEvidence,
    begin,
    complete,
    ensure,
    markAwaitingUser,
    markProgress,
    observePlanTool,
    reconcilePlan,
    updateLivenessFromNotice,
    updatePlanFromTodos,
  };
}

module.exports = {
  createTaskRunRuntime,
  progressValueFromNotice,
  shouldBeginTaskRunAtTurnStart,
};
