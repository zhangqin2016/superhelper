"use strict";

const { failureCodeOf } = require("./turn-failure");

// Parent-task closure is deliberately small and pure. It decides whether an
// incomplete execution turn deserves one continuation; it never starts a
// process or performs a tool call itself.

const MAX_OBJECTIVE_LENGTH = 1_200;
const MAX_LEDGER_ENTRIES = 2_048;

const EXECUTION_CATEGORIES = new Set([
  "bugfix",
  "code",
  "config",
  "release",
  "runtime",
  "server",
  "ui",
]);

const EXECUTION_TASK_TYPES = new Set([
  "code",
  "code_change",
  "configuration_change",
  "runtime_protocol",
  "server_change",
  "ui_change",
]);

// Research turns can accumulate dozens of successful reads/searches and then
// lose only the final synthesis to a provider/step-boundary failure. Continuing
// once from the existing evidence is safer and cheaper than asking the user to
// replay the whole investigation. The recovery prompt explicitly reuses prior
// results and the durable ledger still permits only one closure attempt.
const CLOSURE_TASK_TYPES = new Set([
  ...EXECUTION_TASK_TYPES,
  "external_fact",
]);

// 2026-09-14 audit: the tasks users most often run long — extraction, audits,
// document production, investigations — lost the final synthesis to a
// provider failure and got NO continuation attempt. They are NOT execution
// intents (a plain "read this and summarize" stays read-only, see
// test-task-execution-classification), so they qualify only as LONG-RUNNING
// work that was cut off: a stall / handoff / silent model, with real progress
// behind it. Same one-closure budget; the durable ledger still bounds retries.
const ANALYSIS_TASK_TYPES = new Set(["content_extraction", "architecture_audit", "document_work", "bug_investigation"]);
const ANALYSIS_MIN_EVIDENCE = 3;

/**
 * Work that was CUT OFF mid-flight and has earned another round.
 *
 * Eligibility used to be decided by how the request TEXT was classified, which
 * is the wrong signal for a follow-up: 2026-09-16 a turn that ran 120 successful
 * tool calls and ended stalled with an unfinished command was refused as
 * NON_EXECUTION_TASK, because the user had typed "可以 继续做" and no task
 * contract was built for those four characters. What the turn DID is the
 * evidence; what the request looked like is not. A cut-off turn with real
 * execution behind it continues whatever (if anything) it was classified as.
 */
function isCutOffAnalysisWork(taskContract = {}, payload = {}, evidence = {}) {
  const cutOff = Boolean(payload.stalled) || Boolean(payload.continuationHandoff) || isModelSilentFailure(payload);
  if (!cutOff) return false;
  if (isModelSilentFailure(payload)) {
    // A silent model leaves no receipts by definition; it is gated separately.
    return Boolean(taskContract?.active) && ANALYSIS_TASK_TYPES.has(String(taskContract.taskType || ""));
  }
  return Number(evidence.count || 0) >= ANALYSIS_MIN_EVIDENCE;
}

// A model that returned zero bytes (first-response watchdog) leaves no tool
// evidence by definition; that is exactly the case worth continuing once the
// provider is back, so it must not be filtered as NO_EXECUTION_EVIDENCE.
function isModelSilentFailure(payload = {}) {
  const code = failureCodeOf(payload);
  return Boolean(payload.noFirstResponse) || code === "MODEL_NO_RESPONSE";
}

const MUTATING_OPERATIONS = /^(?:create|change|modify|write|build|package|deploy|release|fix|repair|implement|install|migrate|convert|edit|update|publish|refactor|execute|remove|delete)$/i;

function normalizedStatus(tool) {
  return String(tool?.status || "running").toLowerCase();
}

function compactTool(tool = {}) {
  const input = tool.input && typeof tool.input === "object" ? tool.input : {};
  const label = String(
    input.description || input.title || input.command || input.path || tool.name || tool.id || "tool",
  ).replace(/\s+/g, " ").trim().slice(0, 120);
  return {
    id: String(tool.id || "").slice(0, 120),
    name: String(tool.name || "").slice(0, 80),
    status: normalizedStatus(tool),
    label,
  };
}

function toolEvidenceSnapshot(state = {}) {
  const done = [];
  const failed = [];
  const running = [];
  for (const tool of state.tools?.values?.() || []) {
    const compact = compactTool(tool);
    if (["done", "completed", "success"].includes(compact.status)) done.push(compact);
    else if (["failed", "error", "cancelled", "canceled", "timeout"].includes(compact.status)) failed.push(compact);
    else running.push(compact);
  }
  return {
    done: done.slice(-32),
    failed: failed.slice(-32),
    running: running.slice(-32),
    count: done.length + failed.length + running.length,
  };
}

function hasExecutionIntent(taskContract = {}) {
  if (!taskContract?.active) return false;
  if (CLOSURE_TASK_TYPES.has(String(taskContract.taskType || ""))) return true;
  const categories = Array.isArray(taskContract.categories) ? taskContract.categories : [];
  if (categories.some((category) => EXECUTION_CATEGORIES.has(String(category)))) return true;
  const operation = String(taskContract.semanticIntent?.operation || "");
  if (!MUTATING_OPERATIONS.test(operation)) return false;
  return categories.some((category) => ["architecture_audit", "agent_quality", "release"].includes(String(category)))
    || ["document_work", "media_generation"].includes(require("./task-type-schema").taskTypeDefinition(taskContract.taskType).id);
}

function hasPendingUserInput(state = {}) {
  return Number(state.pendingPermissions?.size || 0) > 0
    || Number(state.pendingQuestions?.size || 0) > 0
    || Number(state.pendingHooks?.size || 0) > 0;
}

function shouldRecoverParentClosure({
  sessionId = "",
  taskContract = null,
  state = {},
  payload = {},
  recoveryLedger = null,
  allowProductiveContinuation = false,
} = {}) {
  const sourceTurnId = String(state.turnId || "").trim();
  const recoveryKey = `parent-closure:${String(sessionId || "").trim()}:${sourceTurnId}`;
  const evidence = toolEvidenceSnapshot(state);
  const fail = (reason) => ({ ok: false, reason, recoveryKey, sourceTurnId, evidence });
  if (!sessionId || !sourceTurnId) return fail("MISSING_TURN_IDENTITY");
  if (payload.loopDetected) return fail("CONFIRMED_LOOP");
  if (payload.continuationStopReason === "no_progress") return fail("NO_PROGRESS");
  // Exhausting the step budget IS execution: the engine ran a full budget of
  // tool calls and was then forced to stop and summarize (its MAX_STEPS prompt
  // disables tools). Such a turn continues regardless of how the request was
  // classified — the alternative is the 2026-09-16 report, a long task that
  // "总是自动停止" at the same place every round.
  const stepExhausted = Boolean(payload.stepBudgetExhausted) || payload.continuationStopReason === "step_budget_exhausted";
  if (!stepExhausted && !hasExecutionIntent(taskContract) && !isCutOffAnalysisWork(taskContract, payload, evidence)) return fail("NON_EXECUTION_TASK");
  if (payload.interruptedByUser || payload.userInterrupted || payload.engineInterrupted) return fail("INTERRUPTED");
  if (
    failureCodeOf(payload) === "TRUNCATED_TURN_END"
    && !state.wasRescueAttempt
  ) return fail("SPECIALIZED_RESCUE");
  const handoff = payload.continuationHandoff;
  const remainingWork = handoff?.schemaVersion === 1 && Array.isArray(handoff.unfinished) && handoff.unfinished.length > 0
    && ((handoff.reason === "budget_exhausted" && Number(handoff.progress) > 0)
      || (handoff.reason === "acceptance_gap" && handoff.unfinished.every(item => ["verification", "delivery", "original_requirement"].includes(item.kind) && typeof item.title === "string" && item.title.trim())));
  if (!remainingWork && !payload.stalled && !payload.failed && !payload.error && !payload.errorCode && !payload.code) return fail("NOT_INCOMPLETE");
  if (hasPendingUserInput(state)) return fail("WAITING_FOR_USER");
  if (!evidence.count && !isModelSilentFailure(payload)) return fail("NO_EXECUTION_EVIDENCE");
  if (state.currentPayload?.parentClosureRecovery && !(allowProductiveContinuation
    && Array.isArray(payload.executionProgressKeys) && payload.executionProgressKeys.length > 0)) return fail("ALREADY_ATTEMPTED");
  if (recoveryLedger?.has?.(recoveryKey)) return fail("ALREADY_CLAIMED");
  return { ok: true, reason: isModelSilentFailure(payload) && !evidence.count ? "ELIGIBLE_MODEL_SILENT" : "ELIGIBLE", recoveryKey, sourceTurnId, evidence, modelSilent: isModelSilentFailure(payload) };
}

function buildParentClosurePrompt({ objective = "", evidence = {}, continuationHandoff = null, workState = null } = {}) {
  const boundedObjective = String(objective || "").trim().slice(0, MAX_OBJECTIVE_LENGTH);
  const counts = `已完成工具 ${Number(evidence.done?.length || 0)} 个，失败 ${Number(evidence.failed?.length || 0)} 个，运行中 ${Number(evidence.running?.length || 0)} 个。`;
  return [
    "[Lily parent-task closure recovery]",
    continuationHandoff?.unfinished?.length ? "继续完成原始任务的剩余工作；保留上一轮已完成的结果。" : "继续完成原始任务。上一轮已经执行过工具，但父任务没有形成最终回答；请基于当前会话中已有的工具结果接着做。",
    `原始任务：${boundedObjective || "继续当前用户要求"}`,
    counts,
    ...(continuationHandoff?.unfinished?.length ? ["上一轮正常结束但尚有验收项未完成：", ...continuationHandoff.unfinished.slice(0, 32).map(item => `- ${String(item.title || "").slice(0, 180)}`)] : []),
    ...require("./turn-work-state").renderWorkState(workState),
    "本次是接续剩余工作，不是重放上一轮命令。已有授权范围保持不变；需要新的权限或用户选择时提出问题，不得绕过；结果未知的写操作先核实，不得盲目重试。",
    "不要只返回计划，也不要重复已经完成的检查。先确认当前文件和状态，再完成剩余的修改、构建、打包、部署或验证步骤。",
    "如果原任务是检索、研究或分析，优先基于已有搜索和读取结果完成综合结论；只补充确实缺失的证据，不要重新抓取已经完成的来源。",
    "结束前必须给出实际完成内容、验证证据和仍然存在的硬阻塞；没有完成就明确说明，不能把计划当成结果。",
  ].join("\n");
}

function createParentClosureLedger({ maxEntries = MAX_LEDGER_ENTRIES } = {}) {
  const claimed = new Set();
  const limit = Math.max(32, Number(maxEntries) || MAX_LEDGER_ENTRIES);
  return {
    claim(key) {
      const normalized = String(key || "").trim();
      if (!normalized || claimed.has(normalized)) return false;
      claimed.add(normalized);
      while (claimed.size > limit) claimed.delete(claimed.values().next().value);
      return true;
    },
    has(key) {
      return claimed.has(String(key || "").trim());
    },
    clear(key) {
      claimed.delete(String(key || "").trim());
    },
    size() {
      return claimed.size;
    },
  };
}

module.exports = {
  isModelSilentFailure,
  isCutOffAnalysisWork,
  buildParentClosurePrompt,
  createParentClosureLedger,
  hasExecutionIntent,
  shouldRecoverParentClosure,
  toolEvidenceSnapshot,
};
