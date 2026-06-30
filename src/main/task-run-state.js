"use strict";

const crypto = require("node:crypto");

const READ_ONLY_TOOLS = new Set(["read", "glob", "grep", "list", "ls", "find", "search"]);

function nowMs() {
  return Date.now();
}

function safeText(value, limit = 500) {
  return String(value || "").trim().slice(0, limit);
}

function defaultPlan() {
  return [
    { id: "understand", title: "Understand request", status: "completed" },
    { id: "execute", title: "Execute with available tools", status: "in_progress" },
    { id: "verify", title: "Verify or report evidence", status: "pending" },
  ];
}

function createTaskRun(input = {}) {
  const ts = Number.isFinite(input.startedAt) ? input.startedAt : nowMs();
  const turnId = safeText(input.turnId, 120);
  return {
    id: input.id || `task_${crypto.randomUUID()}`,
    sessionId: safeText(input.sessionId, 120),
    turnId,
    objective: safeText(input.objective, 1_000),
    status: "running",
    phase: "starting",
    plan: defaultPlan(),
    activeStep: "execute",
    progress: {
      label: "Starting task",
      value: null,
    },
    liveness: {
      status: "starting",
      detail: "",
      lastNoticeCode: "",
      lastHeartbeatAt: ts,
    },
    evidence: [],
    risks: [],
    resumeState: {
      turnId,
      lastToolId: "",
      lastToolName: "",
      hasSideEffects: false,
      nextAction: "Wait for runtime events",
    },
    verification: {
      status: "not_required",
      reason: "",
    },
    startedAt: ts,
    updatedAt: ts,
    lastActivityAt: ts,
    endedAt: null,
  };
}

function compactTaskRun(taskRun = {}) {
  if (!taskRun || typeof taskRun !== "object") return null;
  return {
    id: taskRun.id || "",
    sessionId: taskRun.sessionId || "",
    turnId: taskRun.turnId || "",
    objective: safeText(taskRun.objective, 1_000),
    status: taskRun.status || "running",
    phase: taskRun.phase || "starting",
    plan: Array.isArray(taskRun.plan) ? taskRun.plan.slice(0, 12).map((step) => ({
      id: safeText(step.id, 80),
      title: safeText(step.title, 160),
      status: step.status || "pending",
    })) : [],
    activeStep: taskRun.activeStep || "",
    progress: taskRun.progress && typeof taskRun.progress === "object"
      ? {
          label: safeText(taskRun.progress.label, 240),
          value: Number.isFinite(taskRun.progress.value) ? taskRun.progress.value : null,
        }
      : null,
    liveness: taskRun.liveness && typeof taskRun.liveness === "object"
      ? {
          status: safeText(taskRun.liveness.status || "", 80),
          detail: safeText(taskRun.liveness.detail || "", 500),
          lastNoticeCode: safeText(taskRun.liveness.lastNoticeCode || "", 120),
          lastHeartbeatAt: taskRun.liveness.lastHeartbeatAt || null,
        }
      : null,
    evidence: Array.isArray(taskRun.evidence) ? taskRun.evidence.slice(-20) : [],
    risks: Array.isArray(taskRun.risks) ? taskRun.risks.slice(-20) : [],
    resumeState: taskRun.resumeState && typeof taskRun.resumeState === "object" ? { ...taskRun.resumeState } : {},
    verification: taskRun.verification && typeof taskRun.verification === "object" ? { ...taskRun.verification } : null,
    startedAt: taskRun.startedAt || null,
    updatedAt: taskRun.updatedAt || null,
    lastActivityAt: taskRun.lastActivityAt || null,
    endedAt: taskRun.endedAt || null,
  };
}

function touch(taskRun, ts = nowMs()) {
  if (!taskRun) return null;
  taskRun.updatedAt = ts;
  taskRun.lastActivityAt = ts;
  return taskRun;
}

function markTaskPhase(taskRun, phase, label, patch = {}) {
  if (!taskRun) return null;
  const ts = nowMs();
  taskRun.status = patch.status || taskRun.status || "running";
  taskRun.phase = phase || taskRun.phase || "running";
  taskRun.activeStep = patch.activeStep || taskRun.activeStep || "execute";
  taskRun.progress = {
    label: safeText(label || taskRun.progress?.label || taskRun.phase, 240),
    value: Number.isFinite(patch.value) ? patch.value : null,
  };
  if (patch.resumeState && typeof patch.resumeState === "object") {
    taskRun.resumeState = { ...(taskRun.resumeState || {}), ...patch.resumeState };
  }
  touch(taskRun, ts);
  return taskRun;
}

function addTaskEvidence(taskRun, evidence = {}) {
  if (!taskRun) return null;
  const item = {
    id: evidence.id || `evidence_${crypto.randomUUID()}`,
    kind: safeText(evidence.kind || "runtime_event", 80),
    label: safeText(evidence.label || "", 240),
    status: safeText(evidence.status || "", 80),
    refId: safeText(evidence.refId || "", 160),
    ts: nowMs(),
  };
  taskRun.evidence.push(item);
  if (taskRun.evidence.length > 50) taskRun.evidence.splice(0, taskRun.evidence.length - 50);
  touch(taskRun, item.ts);
  return item;
}

function addTaskRisk(taskRun, risk = {}) {
  if (!taskRun) return null;
  const item = {
    id: risk.id || `risk_${crypto.randomUUID()}`,
    code: safeText(risk.code || "runtime_risk", 120),
    level: safeText(risk.level || "info", 40),
    message: safeText(risk.message || "", 500),
    ts: nowMs(),
  };
  taskRun.risks.push(item);
  if (taskRun.risks.length > 50) taskRun.risks.splice(0, taskRun.risks.length - 50);
  touch(taskRun, item.ts);
  return item;
}

function updateTaskLiveness(taskRun, liveness = {}) {
  if (!taskRun) return null;
  const ts = nowMs();
  taskRun.liveness = {
    ...(taskRun.liveness || {}),
    status: safeText(liveness.status || taskRun.liveness?.status || "running", 80),
    detail: safeText(liveness.detail || "", 500),
    lastNoticeCode: safeText(liveness.noticeCode || taskRun.liveness?.lastNoticeCode || "", 120),
    lastHeartbeatAt: ts,
  };
  taskRun.updatedAt = ts;
  if (liveness.countsAsActivity) taskRun.lastActivityAt = ts;
  return taskRun.liveness;
}

function applyTaskPlanFromTodos(taskRun, todos = []) {
  if (!taskRun || !Array.isArray(todos)) return null;
  const normalized = todos
    .map((todo, index) => ({
      id: `todo_${index + 1}`,
      title: safeText(todo?.content || todo?.activeForm || "", 180),
      status: todo?.status === "completed" || todo?.status === "in_progress" ? todo.status : "pending",
    }))
    .filter((todo) => todo.title);
  if (!normalized.length) return taskRun;
  taskRun.plan = normalized.slice(0, 20);
  const active =
    taskRun.plan.find((step) => step.status === "in_progress") ||
    taskRun.plan.find((step) => step.status !== "completed") ||
    taskRun.plan.at(-1);
  taskRun.activeStep = active?.id || taskRun.activeStep || "execute";
  touch(taskRun);
  return taskRun;
}

function noteTaskToolUse(taskRun, tool = {}) {
  if (!taskRun) return null;
  const name = String(tool.name || "").toLowerCase();
  const readOnly = READ_ONLY_TOOLS.has(name);
  const hadSideEffects = Boolean(taskRun.resumeState?.hasSideEffects);
  taskRun.resumeState = {
    ...(taskRun.resumeState || {}),
    lastToolId: tool.id || taskRun.resumeState?.lastToolId || "",
    lastToolName: tool.name || taskRun.resumeState?.lastToolName || "",
    hasSideEffects: Boolean(hadSideEffects || !readOnly),
    replaySafe: Boolean(readOnly && !hadSideEffects),
    recoveryReason: readOnly && !hadSideEffects ? "read_only_tools_only" : "side_effect_tool_seen",
  };
  touch(taskRun);
  return taskRun.resumeState;
}

function assessTaskVerification({ taskType = "", evidence = [], evidenceGateAssessment = null } = {}) {
  if (evidenceGateAssessment) {
    return {
      status: evidenceGateAssessment.ok ? "verified" : "unverified",
      reason: evidenceGateAssessment.ok
        ? ""
        : safeText(evidenceGateAssessment.reason || evidenceGateAssessment.code || "evidence_gate_failed", 500),
    };
  }
  const normalizedTaskType = String(taskType || "").toLowerCase();
  const labels = (Array.isArray(evidence) ? evidence : [])
    .map((item) => String(item?.label || "").toLowerCase())
    .join("\n");
  if (normalizedTaskType === "code") {
    const hasTest = /\b(test|lint|typecheck|build)\b/.test(labels);
    return hasTest
      ? { status: "verified", reason: "test_or_build_evidence" }
      : { status: "unverified", reason: "missing_test_or_build_evidence" };
  }
  return evidence?.length ? { status: "verified", reason: "evidence_present" } : { status: "not_required", reason: "" };
}

function completeTaskRun(taskRun, terminalType, verification = {}) {
  if (!taskRun) return null;
  const ts = nowMs();
  const failed = terminalType === "turn.failed";
  const interrupted = terminalType === "turn.interrupted";
  const stalled = terminalType === "turn.stalled";
  taskRun.status = failed ? "failed" : interrupted ? "interrupted" : stalled ? "stalled" : "completed";
  taskRun.phase = taskRun.status;
  taskRun.activeStep = "verify";
  taskRun.plan = (taskRun.plan || []).map((step) => {
    if (step.id === "execute") return { ...step, status: failed || stalled || interrupted ? "completed" : "completed" };
    if (step.id === "verify") return { ...step, status: failed || stalled || interrupted ? "pending" : "completed" };
    return step;
  });
  taskRun.progress = {
    label: taskRun.status,
    value: 1,
  };
  taskRun.liveness = {
    ...(taskRun.liveness || {}),
    status: taskRun.status,
    detail: "",
    lastHeartbeatAt: ts,
  };
  taskRun.verification = {
    status: verification.status || assessTaskVerification({ evidence: taskRun.evidence }).status,
    reason: safeText(verification.reason || "", 500),
  };
  taskRun.endedAt = ts;
  touch(taskRun, ts);
  return taskRun;
}

module.exports = {
  createTaskRun,
  compactTaskRun,
  markTaskPhase,
  addTaskEvidence,
  addTaskRisk,
  updateTaskLiveness,
  applyTaskPlanFromTodos,
  noteTaskToolUse,
  assessTaskVerification,
  completeTaskRun,
};
