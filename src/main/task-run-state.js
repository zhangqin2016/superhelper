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

/** Platform-side sync state between the model's plan and what actually ran.
 *  `tools` is the inference window since the plan was last written; the
 *  counters are what the UI shows as staleness ("list not updated for N steps"). */
function defaultPlanSync(ts = nowMs()) {
  return {
    todoAt: null,
    toolsSinceTodo: 0,
    lastToolAt: ts,
    stale: false,
    reconciled: null,
    tools: [],
  };
}

/** Only a plan the MODEL wrote (todowrite → todo_N ids) is inferred against;
 *  the default understand/execute/verify scaffold has nothing to match. */
function isTodoPlan(taskRun) {
  const plan = Array.isArray(taskRun?.plan) ? taskRun.plan : [];
  return plan.length > 0 && plan.every((step) => String(step?.id || "").startsWith("todo_"));
}

function todoProgressLib() {
  try {
    return require("./todo-progress-lib").loadTodoProgressLib();
  } catch {
    return null;
  }
}

function isTodoToolName(name) {
  return String(name || "").toLowerCase() === "todowrite";
}

/** Record a tool observation and refresh the evidence overlay on the plan.
 *  Running tools mark a step "active"; finished successful ones mark it
 *  "evidenced". Returns true when any step's overlay changed. The model's own
 *  `status` is never touched here (no-dumber: the overlay is display-only). */
function observePlanTool(taskRun, tool = {}, opts = {}) {
  if (!taskRun || !tool || isTodoToolName(tool.name)) return false;
  if (!taskRun.planSync) taskRun.planSync = defaultPlanSync();
  const lib = todoProgressLib();
  if (!lib) return false;
  const running = opts.running === true;
  const sync = taskRun.planSync;
  const record = lib.compactTool({ ...tool, running });
  // One row per call id: the running row is replaced by the finished one.
  const idx = record.id ? sync.tools.findIndex((item) => item.id === record.id) : -1;
  if (idx >= 0) sync.tools[idx] = record;
  else sync.tools.push(record);
  if (sync.tools.length > lib.MAX_TOOLS) sync.tools.splice(0, sync.tools.length - lib.MAX_TOOLS);
  const ts = nowMs();
  sync.lastToolAt = ts;
  if (!running) {
    sync.toolsSinceTodo += 1;
    sync.stale = isTodoPlan(taskRun) && taskRun.plan.some((step) => step.status !== "completed");
  }
  if (!isTodoPlan(taskRun)) return false;
  return refreshPlanOverlay(taskRun, lib);
}

function refreshPlanOverlay(taskRun, lib = todoProgressLib()) {
  if (!lib || !taskRun?.planSync) return false;
  const inference = lib.inferPlanProgress(taskRun.plan, taskRun.planSync.tools);
  let changed = false;
  taskRun.plan.forEach((step, index) => {
    const verdict = inference[index] || { inferred: null };
    // Model-side or end-of-turn verdicts outrank the rolling deterministic one.
    if (step.inferred === "model_completed" || step.inferred === "unconfirmed") return;
    const next = step.status === "completed" ? null : verdict.inferred;
    const nextEvidence = next
      ? { toolId: verdict.toolId, toolName: verdict.toolName, snippet: safeText(verdict.snippet, 200), source: "execution" }
      : null;
    if ((step.inferred || null) !== next) changed = true;
    else if (next && (step.evidence?.toolId || "") !== (nextEvidence?.toolId || "")) changed = true;
    step.inferred = next;
    step.evidence = nextEvidence;
  });
  if (changed) touch(taskRun);
  return changed;
}

/** End-of-turn deterministic reconciliation: a step the model left
 *  "in_progress" with no execution evidence becomes "unconfirmed" — the turn is
 *  over, so "in progress" is no longer a truthful reading. Evidenced steps keep
 *  their evidence. Records that the reconciliation happened. */
function reconcilePlanAtTurnEnd(taskRun, terminalType = "turn.completed") {
  if (!taskRun || !isTodoPlan(taskRun)) return false;
  if (!taskRun.planSync) taskRun.planSync = defaultPlanSync();
  refreshPlanOverlay(taskRun);
  let changed = false;
  for (const step of taskRun.plan) {
    if (step.status === "completed") continue;
    if (step.inferred === "evidenced" || step.inferred === "model_completed") continue;
    if (step.status === "in_progress" || step.inferred === "active") {
      if (step.inferred !== "unconfirmed") changed = true;
      step.inferred = "unconfirmed";
      step.evidence = null;
    }
  }
  const sync = taskRun.planSync;
  sync.stale = sync.toolsSinceTodo > 0 && taskRun.plan.some((step) => step.status !== "completed");
  sync.reconciled = { source: "deterministic", terminalType: safeText(terminalType, 40), at: nowMs() };
  if (changed) touch(taskRun);
  return changed;
}

/** Apply a model verdict over the plan with a verification floor: "completed"
 *  is accepted only when the cited quote is literally present in the evidence
 *  the model was shown. A verdict that cannot be verified is ignored. */
function applyModelPlanReconciliation(taskRun, verdictSteps = [], evidenceText = "") {
  if (!taskRun || !isTodoPlan(taskRun) || !Array.isArray(verdictSteps)) return 0;
  const hay = String(evidenceText || "").replace(/\s+/g, " ").toLowerCase();
  let applied = 0;
  for (const verdict of verdictSteps) {
    const index = Number(verdict?.index) - 1;
    const step = taskRun.plan[index];
    if (!step || step.status === "completed") continue;
    if (step.inferred === "evidenced") continue;
    const status = String(verdict?.status || "").toLowerCase();
    const quote = String(verdict?.evidence || verdict?.quote || "").replace(/\s+/g, " ").trim();
    if (status !== "completed" && status !== "in_progress") continue;
    if (quote.length < 4 || !hay.includes(quote.toLowerCase())) continue;
    step.inferred = status === "completed" ? "model_completed" : "active";
    step.evidence = { toolId: "", toolName: "", snippet: safeText(quote, 200), source: "model" };
    applied += 1;
  }
  if (applied) {
    taskRun.planSync = taskRun.planSync || defaultPlanSync();
    taskRun.planSync.reconciled = { ...(taskRun.planSync.reconciled || {}), source: "model", at: nowMs() };
    touch(taskRun);
  }
  return applied;
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
    planSync: defaultPlanSync(ts),
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
    plan: Array.isArray(taskRun.plan) ? taskRun.plan.slice(0, 20).map((step) => ({
      id: safeText(step.id, 80),
      title: safeText(step.title, 160),
      status: step.status || "pending",
      ...(step.inferred ? { inferred: safeText(step.inferred, 24) } : {}),
      ...(step.evidence ? {
        evidence: {
          toolId: safeText(step.evidence.toolId, 120),
          toolName: safeText(step.evidence.toolName, 60),
          snippet: safeText(step.evidence.snippet, 200),
          source: safeText(step.evidence.source || "execution", 20),
        },
      } : {}),
    })) : [],
    planSync: taskRun.planSync && typeof taskRun.planSync === "object"
      ? {
          todoAt: taskRun.planSync.todoAt || null,
          toolsSinceTodo: Number(taskRun.planSync.toolsSinceTodo || 0),
          stale: Boolean(taskRun.planSync.stale),
          reconciled: taskRun.planSync.reconciled ? { ...taskRun.planSync.reconciled } : null,
        }
      : null,
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
  // A fresh todowrite is the model's authoritative statement: the inference
  // window restarts and every overlay is dropped (the model's statuses win).
  const ts = nowMs();
  taskRun.planSync = { ...defaultPlanSync(ts), todoAt: ts };
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
  applyModelPlanReconciliation,
  isTodoPlan,
  observePlanTool,
  reconcilePlanAtTurnEnd,
  noteTaskToolUse,
  buildTaskToolEvidence,
  applyIntentContractToTaskRun,
  assessTaskVerification,
  completeTaskRun,
};
