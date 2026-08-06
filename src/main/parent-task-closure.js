"use strict";

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
  if (String(taskContract.taskType || "") === "external_fact") return false;
  const categories = Array.isArray(taskContract.categories) ? taskContract.categories : [];
  if (categories.some((category) => EXECUTION_CATEGORIES.has(String(category)))) return true;
  if (EXECUTION_TASK_TYPES.has(String(taskContract.taskType || ""))) return true;
  const operation = String(taskContract.semanticIntent?.operation || "");
  if (!MUTATING_OPERATIONS.test(operation)) return false;
  return categories.some((category) => ["architecture_audit", "agent_quality", "release"].includes(String(category)))
    || ["document", "media"].includes(String(taskContract.taskType || ""));
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
} = {}) {
  const sourceTurnId = String(state.turnId || "").trim();
  const recoveryKey = `parent-closure:${String(sessionId || "").trim()}:${sourceTurnId}`;
  const evidence = toolEvidenceSnapshot(state);
  const fail = (reason) => ({ ok: false, reason, recoveryKey, sourceTurnId, evidence });
  if (!sessionId || !sourceTurnId) return fail("MISSING_TURN_IDENTITY");
  if (!hasExecutionIntent(taskContract)) return fail("NON_EXECUTION_TASK");
  if (payload.interruptedByUser || payload.userInterrupted || payload.engineInterrupted) return fail("INTERRUPTED");
  if (String(payload.errorCode || payload.failureCode || "") === "TRUNCATED_TURN_END") return fail("SPECIALIZED_RESCUE");
  if (!payload.stalled && !payload.failed && !payload.error && !payload.errorCode && !payload.code) return fail("NOT_INCOMPLETE");
  if (hasPendingUserInput(state)) return fail("WAITING_FOR_USER");
  if (!evidence.count) return fail("NO_EXECUTION_EVIDENCE");
  if (state.currentPayload?.parentClosureRecovery) return fail("ALREADY_ATTEMPTED");
  if (recoveryLedger?.has?.(recoveryKey)) return fail("ALREADY_CLAIMED");
  return { ok: true, reason: "ELIGIBLE", recoveryKey, sourceTurnId, evidence };
}

function buildParentClosurePrompt({ objective = "", evidence = {} } = {}) {
  const boundedObjective = String(objective || "").trim().slice(0, MAX_OBJECTIVE_LENGTH);
  const counts = `已完成工具 ${Number(evidence.done?.length || 0)} 个，失败 ${Number(evidence.failed?.length || 0)} 个，运行中 ${Number(evidence.running?.length || 0)} 个。`;
  return [
    "[Lily parent-task closure recovery]",
    "继续完成原始任务。上一轮已经执行过工具，但父任务没有形成最终回答；请基于当前会话中已有的工具结果接着做。",
    `原始任务：${boundedObjective || "继续当前用户要求"}`,
    counts,
    "不要只返回计划，也不要重复已经完成的检查。先确认当前文件和状态，再完成剩余的修改、构建、打包、部署或验证步骤。",
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
  buildParentClosurePrompt,
  createParentClosureLedger,
  hasExecutionIntent,
  shouldRecoverParentClosure,
  toolEvidenceSnapshot,
};
