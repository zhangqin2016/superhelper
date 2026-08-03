"use strict";

const crypto = require("node:crypto");
const { resolveToolSemantics } = require("./tool-semantics");
const { taskRunSchemaVersion: TASK_RUN_SCHEMA_VERSION } = require("../shared/runtime-contract.json");
const TRANSIENT_RISK_CODES = new Set(["NO_VISIBLE_PROGRESS"]);
const CODE_VERIFICATION_TASK_TYPES = new Set([
  "agent_quality",
  "bug_investigation",
  "code",
  "code_change",
  "configuration_change",
  "runtime_protocol",
  "server_change",
  "ui_change",
]);
const TEST_EVIDENCE_RE = /\b(test|tests|testing|lint|typecheck|type-check|build|pytest|jest|vitest|mocha|regression|unit)\b/i;
const TEST_CRITERION_RE = /(test|lint|typecheck|type-check|build|pytest|jest|vitest|mocha|regression|unit)/i;
const MANUAL_ALTERNATIVE_RE = /(manual|screenshot|visual|browser|dom)/i;
const MANUAL_EVIDENCE_RE = /\b(manual|screenshot|visual|browser|playwright|dom)\b/i;

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
  let intentContract = null;
  try {
    intentContract = require("./intent-contract").compactIntentContract(input.intentContract);
  } catch {
    intentContract = null;
  }
  return {
    schemaVersion: TASK_RUN_SCHEMA_VERSION,
    id: input.id || `task_${crypto.randomUUID()}`,
    agentGraphId: safeText(input.agentGraphId, 120),
    sessionId: safeText(input.sessionId, 120),
    turnId,
    objective: safeText(input.objective, 1_000),
    status: "running",
    completionStatus: "running",
    intentContractId: intentContract?.contractId || "",
    intentRevision: intentContract?.revision || 0,
    intentRelation: intentContract?.relation || "new",
    deliverables: intentContract?.deliverables || [],
    successCriteria: intentContract?.successCriteria || [],
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
    schemaVersion: TASK_RUN_SCHEMA_VERSION,
    id: taskRun.id || "",
    agentGraphId: safeText(taskRun.agentGraphId, 120),
    sessionId: taskRun.sessionId || "",
    turnId: taskRun.turnId || "",
    objective: safeText(taskRun.objective, 1_000),
    status: taskRun.status || "running",
    completionStatus: taskRun.completionStatus || taskRun.status || "running",
    intentContractId: safeText(taskRun.intentContractId, 120),
    intentRevision: Number(taskRun.intentRevision || 0),
    intentRelation: safeText(taskRun.intentRelation || "new", 40),
    deliverables: Array.isArray(taskRun.deliverables) ? taskRun.deliverables.slice(0, 12).map((item) => safeText(item)) : [],
    successCriteria: Array.isArray(taskRun.successCriteria) ? taskRun.successCriteria.slice(0, 20).map((item) => safeText(item)) : [],
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
    status: safeText(risk.status || "active", 40),
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
  const semantics = resolveToolSemantics(tool);
  const readOnly = semantics.readOnly || semantics.replaySafe;
  const dangerous = semantics.destructive;
  const hadSideEffects = Boolean(taskRun.resumeState?.hasSideEffects);
  const previousLevel = taskRun.resumeState?.recoveryLevel || "safe";
  const recoveryLevel = dangerous || previousLevel === "dangerous"
    ? "dangerous"
    : readOnly && !hadSideEffects
      ? "safe"
      : "confirm";
  taskRun.resumeState = {
    ...(taskRun.resumeState || {}),
    lastToolId: tool.id || taskRun.resumeState?.lastToolId || "",
    lastToolName: tool.name || taskRun.resumeState?.lastToolName || "",
    hasSideEffects: Boolean(hadSideEffects || !readOnly),
    replaySafe: Boolean(readOnly && !hadSideEffects),
    recoveryLevel,
    recoveryReason: recoveryLevel === "safe"
      ? "read_only_tools_only"
      : recoveryLevel === "dangerous"
        ? "write_or_destructive_tool_seen"
        : "confirmation_required_for_tool_replay",
  };
  touch(taskRun);
  return taskRun.resumeState;
}

function buildTaskToolEvidence(tool = {}) {
  const command = safeText(
    tool.input?.command || tool.input?.cmd || tool.input?.script || tool.input?.path || tool.input?.file_path || "",
    320,
  );
  const label = [tool.name || "Tool", tool.title || "", command, tool.status || "done"]
    .map((value) => safeText(value, 320))
    .filter(Boolean)
    .join(" ");
  return {
    kind: "tool_result",
    label,
    status: tool.status || "done",
    refId: tool.id || "",
  };
}

function applyIntentContractToTaskRun(taskRun, intentContractValue) {
  if (!taskRun) return null;
  let intentContract = null;
  try {
    intentContract = require("./intent-contract").compactIntentContract(intentContractValue);
  } catch {
    intentContract = null;
  }
  if (!intentContract) return null;
  taskRun.intentContractId = intentContract.contractId;
  taskRun.intentRevision = intentContract.revision;
  taskRun.intentRelation = intentContract.relation;
  taskRun.objective = safeText(intentContract.objective || taskRun.objective, 1_000);
  taskRun.deliverables = intentContract.deliverables;
  taskRun.successCriteria = intentContract.successCriteria;
  touch(taskRun);
  return taskRun;
}

function assessTaskVerification({
  taskType = "",
  evidence = [],
  evidenceGateAssessment = null,
  evidenceSummary = null,
  successCriteria = [],
  deliverables = [],
  fileChangeCount = 0,
  artifactCount = 0,
} = {}) {
  if (evidenceGateAssessment?.ok === false) {
    return {
      status: "unverified",
      reason: safeText(evidenceGateAssessment.reason || evidenceGateAssessment.code || "evidence_gate_failed", 500),
      criteria: [],
    };
  }
  const normalizedTaskType = String(taskType || "").toLowerCase();
  if (normalizedTaskType === "content_extraction") {
    const coverage = evidenceSummary?.sourceContentCoverage || {};
    if (!evidenceSummary?.hasSourceContentEvidence) {
      return { status: "unverified", reason: "missing_source_content_evidence", criteria: [] };
    }
    if (coverage.status === "complete") {
      return { status: "verified", reason: "source_content_extracted", criteria: [] };
    }
    return {
      status: "observed",
      reason: coverage.status === "partial" ? "partial_source_content" : "source_content_available",
      criteria: [],
    };
  }
  const successfulEvidence = (Array.isArray(evidence) ? evidence : []).filter(
    (item) => !/fail|error/i.test(String(item?.status || "")),
  );
  const labels = successfulEvidence
    .map((item) => String(item?.label || "").toLowerCase())
    .join("\n");
  const criteria = (Array.isArray(successCriteria) ? successCriteria : [])
    .map((criterion) => safeText(criterion, 180))
    .filter(Boolean);
  const requiresTest = CODE_VERIFICATION_TASK_TYPES.has(normalizedTaskType) && criteria.some(
    (criterion) => TEST_CRITERION_RE.test(criterion) && !MANUAL_ALTERNATIVE_RE.test(criterion),
  );
  const hasTest = TEST_EVIDENCE_RE.test(labels);
  const hasManualEvidence = MANUAL_EVIDENCE_RE.test(labels);
  let missingMachineCriterion = false;
  const criterionResults = criteria.map((criterion) => {
    if (TEST_CRITERION_RE.test(criterion) && CODE_VERIFICATION_TASK_TYPES.has(normalizedTaskType)) {
      const allowsManual = MANUAL_ALTERNATIVE_RE.test(criterion);
      const satisfied = hasTest || (allowsManual && hasManualEvidence);
      if (!satisfied) missingMachineCriterion = true;
      return {
        criterion,
        status: satisfied ? "verified" : "unverified",
        evidence: hasTest ? "test_or_build_evidence" : hasManualEvidence ? "manual_or_visual_evidence" : "",
      };
    }
    if (/artifact|output|preview|openable|document|media/i.test(criterion)) {
      const hasArtifact = Number(fileChangeCount) > 0 || Number(artifactCount) > 0;
      return { criterion, status: hasArtifact ? "verified" : "not_observed", evidence: hasArtifact ? "artifact_record" : "" };
    }
    return {
      criterion,
      status: successfulEvidence.length ? "observed" : "not_observed",
      evidence: successfulEvidence.length ? "tool_evidence_present" : "",
    };
  });
  if (missingMachineCriterion) {
    return { status: "unverified", reason: requiresTest ? "missing_test_or_build_evidence" : "missing_manual_or_test_evidence", criteria: criterionResults };
  }
  if (requiresTest) {
    return hasTest
      ? { status: "verified", reason: "test_or_build_evidence", criteria: criterionResults }
      : { status: "unverified", reason: "missing_test_or_build_evidence", criteria: criterionResults };
  }
  if (normalizedTaskType === "code" || normalizedTaskType === "code_change") {
    return hasTest
      ? { status: "verified", reason: "test_or_build_evidence", criteria: criterionResults }
      : { status: "unverified", reason: "missing_test_or_build_evidence", criteria: criterionResults };
  }
  if (evidenceGateAssessment?.ok === true) {
    return { status: "verified", reason: "evidence_gate_passed", criteria: criterionResults };
  }
  if (successfulEvidence.length || Number(fileChangeCount) > 0 || Number(artifactCount) > 0) {
    return { status: "observed", reason: "evidence_present", criteria: criterionResults };
  }
  return {
    status: Array.isArray(deliverables) && deliverables.length ? "unverified" : "not_required",
    reason: Array.isArray(deliverables) && deliverables.length ? "missing_delivery_evidence" : "",
    criteria: criterionResults,
  };
}

function completeTaskRun(taskRun, terminalType, verification = {}) {
  if (!taskRun) return null;
  const ts = nowMs();
  const failed = terminalType === "turn.failed";
  const interrupted = terminalType === "turn.interrupted";
  const stalled = terminalType === "turn.stalled";
  taskRun.status = failed ? "failed" : interrupted ? "interrupted" : stalled ? "stalled" : "completed";
  taskRun.completionStatus = failed
    ? "failed"
    : interrupted
      ? "interrupted"
      : stalled
        ? "stalled"
        : verification.status === "verified"
          ? "verified_complete"
          : verification.status === "unverified"
            ? "delivered_unverified"
            : verification.status === "observed"
              ? "completed_observed"
              : "completed";
  taskRun.phase = taskRun.status;
  taskRun.activeStep = "verify";
  taskRun.plan = (taskRun.plan || []).map((step) => {
    if (!failed && !stalled && !interrupted) return { ...step, status: "completed" };
    if (step.id === "execute") return { ...step, status: "completed" };
    if (step.id === "verify") return { ...step, status: "pending" };
    return step;
  });
  if (!failed && !stalled && !interrupted && Array.isArray(taskRun.risks)) {
    taskRun.risks = taskRun.risks.map((risk) => (
      TRANSIENT_RISK_CODES.has(risk?.code) ? { ...risk, status: "resolved", resolvedAt: ts } : risk
    ));
  }
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
    ...verification,
    status: verification.status || assessTaskVerification({ evidence: taskRun.evidence }).status,
    reason: safeText(verification.reason || "", 500),
    criteria: Array.isArray(verification.criteria) ? verification.criteria.slice(0, 20) : [],
  };
  taskRun.endedAt = ts;
  touch(taskRun, ts);
  return taskRun;
}

module.exports = {
  TASK_RUN_SCHEMA_VERSION,
  createTaskRun,
  compactTaskRun,
  markTaskPhase,
  addTaskEvidence,
  addTaskRisk,
  updateTaskLiveness,
  applyTaskPlanFromTodos,
  noteTaskToolUse,
  buildTaskToolEvidence,
  applyIntentContractToTaskRun,
  assessTaskVerification,
  completeTaskRun,
};
