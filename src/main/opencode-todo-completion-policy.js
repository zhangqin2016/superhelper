"use strict";

const fs = require("node:fs");

const TODO_COMPLETION_GATE_MAX_ATTEMPTS = 3;
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

module.exports = {
  TODO_COMPLETION_GATE_MAX_ATTEMPTS,
  buildTodoContinuationPrompt,
  detectIncompleteDeliverable,
  nativeTodoSnapshot,
  normalizeTodoStatus,
  todoTitle,
};
