"use strict";

const fs = require("node:fs");
const { markInternalPrompt } = require("./internal-prompt-marker");

// Max CONSECUTIVE continuation nudges that produced no progress. The caller only
// resets its counter on unique completed execution or a shrinking todo set, bounding
// confirmed no-progress rather than effort: a model that keeps completing items
// keeps earning nudges. Two consecutive no-progress nudges, measured on the
// field engine DB (2026-09-28): after a nudge that changed nothing, a second one
// still led to completed items 7/16 times; a third, 7/23 across all later
// attempts. A model WAITING on the user is not pushed into guessing by the
// count — the continuation prompt tells it to stop and ask — and its pre-gate
// answer is kept either way (withPreGateAnswer).
const TODO_COMPLETION_GATE_MAX_ATTEMPTS = 2;
// Absolute per-turn ceiling on continuation nudges. Real progress refills the
// budget above, so without this cap a model that keeps re-planning its todo list
// can be pushed back into the same turn indefinitely (a field turn burned 7
// nudges / 13 minutes re-asking for the same 2 user-blocked items).
const TODO_COMPLETION_GATE_MAX_TOTAL_ATTEMPTS = 6;
/**
 * Detect only high-confidence broken deliverables, from STRUCTURED evidence:
 *   1. deliverables the task contract declares (task-delivery-manifest), and
 *   2. files this turn's own file-writing tool calls produced (producedPaths).
 * It never reads paths out of the answer prose. Prose is where a how-to answer
 * TELLS the user about paths ("edit /etc/shadowsocks-rust/config.json on your
 * server"); treating those as claims made this gate demand local files, drove
 * the model to write a real password config into the repo, and replaced the
 * user's answer (2026-09-28). Claude Code and Codex CLI likewise ground "what
 * was produced" in the tool ledger, not in the reply text. Ambiguous or
 * unreadable paths fail open so this guard cannot loop.
 */
function detectIncompleteDeliverable(_output, { deliverables = [], workspacePath = "", producedPaths = [] } = {}) {
  const manifest = require("./task-delivery-manifest").inspectDeliverables(deliverables, workspacePath);
  const broken = manifest.find(item => item.repairable && ["missing", "empty"].includes(item.status));
  if (broken) return { path: broken.path, reason: broken.status === "missing" ? "does not exist" : "is empty" };
  const seen = new Set();
  for (const filePath of Array.isArray(producedPaths) ? producedPaths : []) {
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    if (seen.size > 32) break;
    try {
      if (!fs.existsSync(filePath)) return { path: filePath, reason: "does not exist" };
      if (fs.statSync(filePath).isFile() && fs.statSync(filePath).size === 0) return { path: filePath, reason: "is empty" };
    } catch {
      // Fail open when the local filesystem cannot prove a violation.
    }
  }
  return null;
}

/**
 * The deliverable gate's corrective round must not REPLACE the answer the user
 * asked for — its reply is usually only "fixed, the file now exists". Keep the
 * pre-gate answer and append the correction, as a CLI transcript would show both.
 */
function withPreGateAnswer(gates = {}, payload = {}) {
  const before = String(gates?.preGateOutput || "").trim();
  if (!before) return payload;
  const after = String(payload?.output || "").trim();
  if (after.includes(before)) return payload;
  return { ...payload, output: after ? `${before}\n\n---\n\n${after}` : before };
}

function normalizeTodoStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "completed" || value === "done") return "completed";
  if (["in_progress", "in-progress", "running", "active"].includes(value)) return "in_progress";
  return "pending";
}

function todoTitle(todo = {}, index = 0) {
  return String(todo.content || todo.activeForm || todo.title || todo.text || `Todo ${index + 1}`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function nativeTodoSnapshot(todos = []) {
  const normalized = (Array.isArray(todos) ? todos : [])
    .map((todo, index) => ({
      title: todoTitle(todo, index),
      status: normalizeTodoStatus(todo?.status),
    }))
    .filter((todo) => todo.title);
  const unfinished = normalized.filter((todo) => todo.status !== "completed");
  return {
    total: normalized.length,
    completed: normalized.length - unfinished.length,
    unfinished,
  };
}

function buildTodoContinuationPrompt(snapshot = {}, attempt = 1, maxAttempts = TODO_COMPLETION_GATE_MAX_ATTEMPTS) {
  const unfinished = Array.isArray(snapshot.unfinished) ? snapshot.unfinished : [];
  const listed = unfinished.slice(0, 12).map((todo, index) => (
    `${index + 1}. [${todo.status || "pending"}] ${todo.title}`
  ));
  if (unfinished.length > listed.length) listed.push(`...and ${unfinished.length - listed.length} more`);
  // The platform is nudging itself, not relaying the user. Tagged here so the
  // conversation can hide this turn without having to recognise its wording.
  // [gate: internal-prompt-provenance]
  return markInternalPrompt([
    "Task continuity check: the native todo list still has unfinished todo items.",
    `Progress: ${snapshot.completed || 0}/${snapshot.total || 0} completed. Continue from the current unfinished item and do not stop after a partial todo update.`,
    "Use tools as needed. When the requested work is genuinely complete, update every todo item to completed, then provide the final answer.",
    "If an item needs the user's decision or input, stop and ask them plainly instead of guessing.",
    `Continuation attempt: ${attempt}/${maxAttempts}.`,
    "Unfinished todo items:",
    ...listed,
  ].join("\n"));
}

/**
 * Short factual tail appended to an ANSWERED turn that still has unfinished
 * todos. This replaces the old behaviour of marking such a turn `stalled`: the
 * answer is real, so the honest signal is a one-line note, not a failure banner.
 */
function buildUnfinishedTodoNotice(snapshot = {}, limit = 4) {
  const unfinished = Array.isArray(snapshot.unfinished) ? snapshot.unfinished : [];
  if (!unfinished.length) return "";
  const listed = unfinished.slice(0, limit).map((todo) => todo.title).filter(Boolean);
  if (unfinished.length > listed.length) listed.push(`…另外 ${unfinished.length - listed.length} 项`);
  return `（本轮还有 ${unfinished.length} 项待办没有标记完成：${listed.join("；")}）`;
}

/**
 * What a clean turn end should do about unfinished todos.
 * `attempts` counts CONSECUTIVE nudges that produced no progress (the caller
 * resets it on execution progress or a shrinking unfinished set); `totalAttempts` is the whole
 * turn's nudge count.
 */
function todoContinuationDecision(snapshot = {}, attempts = 0, totalAttempts = 0) {
  if (!snapshot.total || !(snapshot.unfinished || []).length) return "skip";
  if (attempts >= TODO_COMPLETION_GATE_MAX_ATTEMPTS) return "settle";
  if (totalAttempts >= TODO_COMPLETION_GATE_MAX_TOTAL_ATTEMPTS) return "settle";
  return "nudge";
}

/**
 * Settle payload for a turn the gate has given up nudging.
 *
 * A turn that produced a real answer is NOT stalled — the model may have
 * deliberately parked the remaining items (typically blocked on a user
 * decision). Marking such a turn `stalled` buried a complete delivery under a
 * "本轮没有形成完整最终回答" banner. Only an answerless turn keeps that terminal.
 */
function rememberTodoProgress(gate, unfinished) {
  if (unfinished >= gate.best) return;
  if (Number.isFinite(gate.best)) gate.progress = (gate.progress || 0) + 1;
  gate.best = unfinished;
  gate.attempts = 0;
}

function buildTodoGiveUpPayload(payload = {}, snapshot = {}, collectedOutput = "", { gate = {}, decision = "settle" } = {}) {
  const output = String(payload?.output || collectedOutput || "").trim();
  const notice = buildUnfinishedTodoNotice(snapshot);
  const noProgress = Number(gate.attempts || 0) >= TODO_COMPLETION_GATE_MAX_ATTEMPTS;
  const budgetExhausted = !noProgress && (decision !== "settle"
    || Number(gate.total || 0) >= TODO_COMPLETION_GATE_MAX_TOTAL_ATTEMPTS);
  const stopReason = budgetExhausted ? "turn_budget_exhausted" : "no_progress";
  const reasonNotice = budgetExhausted
    ? "本轮自动接续已达到上限；剩余工作尚未完成。"
    : "连续接续未观察到新的执行进展；已停止重复催促，剩余工作尚未完成。";
  return {
    ...payload,
    ...(output ? {} : { stalled: true }),
    unfinishedTodoCount: (snapshot.unfinished || []).length,
    continuationStopReason: stopReason,
    continuationHandoff: budgetExhausted && gate.progress > 0
      ? { schemaVersion: 1, reason: "budget_exhausted", progress: gate.progress, unfinished: (snapshot.unfinished || []).slice(0, 32) }
      : undefined,
    output: notice ? [output, notice, reasonNotice].filter(Boolean).join("\n\n") : output,
  };
}

module.exports = {
  withPreGateAnswer,
  rememberTodoProgress,
  TODO_COMPLETION_GATE_MAX_ATTEMPTS,
  TODO_COMPLETION_GATE_MAX_TOTAL_ATTEMPTS,
  buildTodoContinuationPrompt,
  buildTodoGiveUpPayload,
  buildUnfinishedTodoNotice,
  todoContinuationDecision,
  detectIncompleteDeliverable,
  nativeTodoSnapshot,
  normalizeTodoStatus,
  todoTitle,
};
