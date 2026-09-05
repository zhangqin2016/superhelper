"use strict";
/**
 * End-of-turn plan reconciliation with the model — the semantic escalation
 * above the deterministic evidence overlay (task-run-state.observePlanTool).
 *
 * The deterministic pass can only vouch for steps that carry a unique
 * identifier ("pull safar-rag:a1892790"). Steps like "verify all archives" have
 * nothing to string-match, so when the turn ends with such steps still open and
 * the list stale, ONE small structured call asks the model to rule on them —
 * judging ONLY from the quoted execution record, never from its own knowledge.
 *
 * Hard floors (same discipline as evidence-entailment-judge):
 *   - "completed" is accepted only with a verbatim quote that is literally
 *     present in the evidence shown (applyModelPlanReconciliation verifies).
 *   - The model's own todo list is never rewritten; the verdict is an overlay
 *     labelled "model_completed" in the UI.
 *   - Fail-open: no connection, timeout, malformed output → nothing applied.
 * Kill switch: LILY_TODO_MODEL_RECONCILE=0. Timeout: LILY_TODO_RECONCILE_TIMEOUT_MS
 * (default 10s — this sits in the sealing path, so it stays short).
 */
const { getLogger } = require("./logger");
const { applyModelPlanReconciliation, isTodoPlan } = require("./task-run-state");

const log = getLogger("todo-plan-reconciler");
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TOOLS = 16;
const SNIP = 240;

function enabled() {
  return process.env.LILY_TODO_MODEL_RECONCILE !== "0";
}

function timeoutMs() {
  const raw = Number(process.env.LILY_TODO_RECONCILE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function snip(value, limit = SNIP) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** Steps the deterministic pass could not decide: open, no evidence overlay. */
function undecidedSteps(taskRun) {
  return (taskRun.plan || []).filter((step) => step.status !== "completed" && !step.inferred);
}

/** The model reads the command/path, not the JSON envelope around it. The
 *  same text is what quotes are verified against, so the two stay consistent. */
function inputSummary(inputText) {
  const raw = String(inputText || "");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const key of ["command", "cmd", "script", "file_path", "filePath", "path", "pattern", "query", "url", "description"]) {
        if (typeof parsed[key] === "string" && parsed[key].trim()) return parsed[key];
      }
    }
  } catch {
    /* plain text input */
  }
  return raw;
}

function buildEvidenceLines(taskRun) {
  const tools = Array.isArray(taskRun.planSync?.tools) ? taskRun.planSync.tools.slice(-MAX_TOOLS) : [];
  return tools
    .filter((tool) => !tool.running)
    .map((tool, index) => `E${index + 1} [${tool.name}${tool.ok ? "" : " FAILED"}] input: ${snip(inputSummary(tool.inputText))} | output: ${snip(tool.outputText)}`);
}

function buildPrompt(taskRun) {
  const steps = (taskRun.plan || []).map((step, index) => {
    const state = step.status === "completed" ? "completed (by model)" : step.inferred ? `${step.status}, evidence: ${step.inferred}` : step.status;
    return `${index + 1}. ${snip(step.title, 160)} — ${state}`;
  });
  const evidence = buildEvidenceLines(taskRun);
  return [
    "You audit a task plan against an execution record. Judge ONLY from the record below; never assume a step happened because it is plausible.",
    "For every step NOT already marked completed, output its status: completed | in_progress | pending | unknown.",
    "For completed or in_progress you MUST cite a verbatim quote (4-80 characters) copied exactly from one evidence line that proves it. Without a quote, answer unknown.",
    "Return ONLY JSON: {\"steps\":[{\"index\":<1-based>,\"status\":\"...\",\"evidence\":\"<verbatim quote>\"}]}",
    "",
    "PLAN:",
    ...steps,
    "",
    "EXECUTION RECORD:",
    ...evidence,
  ].join("\n");
}

function extractJson(raw = "") {
  const text = String(raw || "");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1), text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && Array.isArray(parsed.steps)) return parsed;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

/** Decide whether the model pass is warranted at all. Pure. */
function shouldReconcileWithModel(taskRun) {
  if (!enabled() || !taskRun || !isTodoPlan(taskRun)) return { ok: false, reason: "not_applicable" };
  const sync = taskRun.planSync || {};
  if (!(Number(sync.toolsSinceTodo) > 0)) return { ok: false, reason: "list_fresh" };
  if (!undecidedSteps(taskRun).length) return { ok: false, reason: "nothing_undecided" };
  if (!buildEvidenceLines(taskRun).length) return { ok: false, reason: "no_evidence" };
  return { ok: true, reason: "" };
}

/**
 * @param {{taskRun: object, post?: Function, resolveConnection?: Function}} input
 *   `post`/`resolveConnection` are injectable for tests; defaults come from the
 *   evidence judge so the reconciler uses the SAME connection discipline.
 */
async function reconcilePlanWithModel({ taskRun, post, resolveConnection } = {}) {
  const gate = shouldReconcileWithModel(taskRun);
  if (!gate.ok) return { applied: 0, reason: gate.reason };
  let judge;
  try {
    judge = require("./evidence-entailment-judge");
  } catch (error) {
    return { applied: 0, reason: `judge_unavailable:${error?.message || error}` };
  }
  const resolve = resolveConnection || judge.resolveJudgeConnectionDetailed;
  const send = post || judge.postJudgeChat;
  const { connection, reason } = resolve() || {};
  if (!connection) return { applied: 0, reason: reason || "no_connection" };
  const diagnostics = { reason: "" };
  const raw = await send({ connection, prompt: buildPrompt(taskRun), timeoutMs: timeoutMs(), diagnostics });
  if (!raw) return { applied: 0, reason: diagnostics.reason || "empty_response" };
  const verdict = extractJson(raw);
  if (!verdict) return { applied: 0, reason: "malformed_verdict" };
  const evidenceText = buildEvidenceLines(taskRun).join("\n");
  const applied = applyModelPlanReconciliation(taskRun, verdict.steps, evidenceText);
  if (applied) log.info("plan reconciled by model: %d step(s)", applied);
  return { applied, reason: applied ? "" : "no_verifiable_verdict" };
}

module.exports = {
  buildPrompt,
  extractJson,
  reconcilePlanWithModel,
  shouldReconcileWithModel,
};
