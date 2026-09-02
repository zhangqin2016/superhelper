"use strict";

const fs = require("node:fs");

// Max CONSECUTIVE continuation nudges that produced no progress. The caller only
// resets its counter when the unfinished todo set actually shrinks, so this bounds
// confirmed no-progress rather than effort: a model that keeps completing items
// keeps earning nudges, a blocked one is asked twice and then left alone.
const TODO_COMPLETION_GATE_MAX_ATTEMPTS = 2;
// Absolute per-turn ceiling on continuation nudges. Real progress refills the
// budget above, so without this cap a model that keeps re-planning its todo list
// can be pushed back into the same turn indefinitely (a field turn burned 7
// nudges / 13 minutes re-asking for the same 2 user-blocked items).
const TODO_COMPLETION_GATE_MAX_TOTAL_ATTEMPTS = 6;
const DELIVERABLE_EXT = "docx|xlsx|pptx|pdf|png|jpe?g|gif|webp|svg|mp3|wav|mp4|webm|html|csv|zip";
const DELIVERABLE_PATH_RE = new RegExp(
  String.raw`(?:^|[\s"'` + "`" + String.raw`(>])((?:/|[A-Za-z]:\\)[^\s"'` + "`" + String.raw`)<>|]+\.(?:${DELIVERABLE_EXT}))`,
  "gi",
);

/**
 * Detect only high-confidence broken deliverables. Ambiguous or unreadable
 * paths fail open so this guard cannot turn a successful response into a loop.
 */
function detectIncompleteDeliverable(output) {
  const text = String(output || "");
  if (!text) return null;
  const seen = new Set();
  for (const match of text.matchAll(DELIVERABLE_PATH_RE)) {
    const filePath = match[1];
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    if (seen.size > 12) break;
    try {
      if (!fs.existsSync(filePath)) return { path: filePath, reason: "does not exist" };
      if (fs.statSync(filePath).size === 0) return { path: filePath, reason: "is empty" };
    } catch {
      // Fail open when the local filesystem cannot prove a violation.
    }
  }
  return null;
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
  return [
    "Task continuity check: the native todo list still has unfinished todo items.",
    `Progress: ${snapshot.completed || 0}/${snapshot.total || 0} completed. Continue from the current unfinished item and do not stop after a partial todo update.`,
    "Use tools as needed. When the requested work is genuinely complete, update every todo item to completed, then provide the final answer.",
    `Continuation attempt: ${attempt}/${maxAttempts}.`,
    "Unfinished todo items:",
    ...listed,
  ].join("\n");
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
 * resets it only when the unfinished set shrinks); `totalAttempts` is the whole
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
function buildTodoGiveUpPayload(payload = {}, snapshot = {}, collectedOutput = "") {
  const output = String(payload?.output || collectedOutput || "").trim();
  const notice = buildUnfinishedTodoNotice(snapshot);
  return {
    ...payload,
    ...(output ? {} : { stalled: true }),
    unfinishedTodoCount: (snapshot.unfinished || []).length,
    output: output && notice ? `${output}\n\n${notice}` : output,
  };
}

module.exports = {
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
