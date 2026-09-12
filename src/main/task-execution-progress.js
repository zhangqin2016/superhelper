"use strict";

const { createHash } = require("node:crypto");
const { executionReceipt } = require("./task-verification-receipt");
const { stableToolResult } = require("./job-observation-lib");
const turnReceipts = new WeakMap();
const LIMIT = 1024;
const CONTROL_TOOLS = new Set(["todowrite", "todoread", "todo_write", "todo_read", "update_plan", "question", "ask_user", "askuserquestion"]);

function canonical(value, depth = 0) {
  if (depth > 12) throw new Error("oversized receipt");
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]));
  return value;
}

/** Native completion observations only: this grants no authority to replay a tool. */
function rememberExecutionProgress(gate, draft = {}) {
  if (!gate || typeof gate !== "object") return false;
  try {
    let state = turnReceipts.get(gate);
    if (!state) { state = { active: new Map(), seen: new Set() }; turnReceipts.set(gate, state); }
    const payload = draft.payload || {};
    const id = String(payload.id || "");
    if (!id) return false;
    if (draft.type === "tool.started") {
      if (state.active.size < LIMIT) state.active.set(id, { name: payload.name, input: payload.input });
      return false;
    }
    if (draft.type !== "tool.done") return false;
    const started = state.active.get(id);
    state.active.delete(id);
    if (!started || payload.isError === true) return false;
    const name = String(started.name || "").trim().toLowerCase();
    if (!name || CONTROL_TOOLS.has(name.split(/[.:/]/).pop())) return false;
    const nativeExit = payload.metadata?.exit ?? payload.metadata?.exitCode;
    if (nativeExit !== undefined && nativeExit !== 0) return false;
    const { exitCode: exit } = executionReceipt({ ...started, ...payload, name, status: "done", completionObserved: true, result: payload.content ?? payload.result });
    if ((exit !== undefined && exit !== 0) || (["bash", "shell_command", "exec_command"].includes(name) && exit !== 0)) return false;
    const input = { ...started.input };
    // Presentation labels and timeouts do not make an identical command new work.
    for (const key of ["description", "title", "timeout", "timeout_ms"]) delete input[key];
    const serialized = JSON.stringify(canonical([name, input, stableToolResult(name, input, payload.content ?? payload.result ?? "")]));
    if (serialized.length > 2_000_000) return false;
    const fingerprint = createHash("sha256").update(serialized).digest("hex");
    if (state.seen.has(fingerprint)) return false;
    state.seen.add(fingerprint);
    // This is a bounded recent-observation window, not an acceptance ledger.
    // Saturating it must not disable progress detection for the rest of a long
    // turn. Absolute continuation/step caps remain independent of this signal:
    // even a cycle longer than this window cannot earn unbounded re-entry.
    if (state.seen.size > LIMIT) state.seen.delete(state.seen.values().next().value);
    gate.progress = (gate.progress || 0) + 1;
    gate.attempts = 0;
    return true;
  } catch { return false; } // Malformed receipts retain the existing todo-only policy.
}

function executionProgressKeys(gate) {
  return [...(turnReceipts.get(gate)?.seen || [])].slice(-128);
}

module.exports = { rememberExecutionProgress, executionProgressKeys };
