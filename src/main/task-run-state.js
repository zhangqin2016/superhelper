"use strict";

const crypto = require("node:crypto");

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
  taskRun.verification = {
    status: verification.status || (taskRun.evidence.length ? "verified" : "not_required"),
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
  completeTaskRun,
};
