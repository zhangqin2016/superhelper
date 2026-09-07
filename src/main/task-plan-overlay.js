"use strict";

const { nowMs, safeText, touch } = require("./task-run-values");

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

module.exports = { defaultPlanSync, isTodoPlan, observePlanTool, reconcilePlanAtTurnEnd, applyModelPlanReconciliation, refreshPlanOverlay };
