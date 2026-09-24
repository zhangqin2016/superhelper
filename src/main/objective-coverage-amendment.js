"use strict";

/**
 * The objective-coverage verdict, delivered after the answer rather than
 * before it.
 *
 * The audit is a model call that writes a verdict with verbatim quotes. On an
 * 18-token/s gateway that is a minute of output, and it sat in front of the
 * answer: every task turn made the user wait for it, and with a fixed 10s bound
 * it failed on every one (164 of 165 recorded verdicts "unavailable") — a wait
 * that bought nothing. Now the turn completes the way it always completed when
 * the audit could not answer — verification as it stands, coverage unknown —
 * and the audit runs beside the next thing the user does. When its verdict
 * lands and changes the conclusion, the conclusion is amended where it lives:
 * the task lifecycle (the current truth) and the turn record (what reopening
 * the conversation shows). The task result stays as it was at delivery; it is
 * the record of what was delivered.
 *
 * The verdict is recomputed from the verification as it stood BEFORE coverage
 * was applied, through the same rules delivery used (applyObjectiveCoverage,
 * then completeTaskRun), so the two paths cannot disagree about what a verdict
 * means.
 */

const { getLogger } = require("./logger");

const log = getLogger("objective-coverage");

/** What delivery records while the audit has not answered: exactly the
 *  outcome an unavailable audit always produced. */
const COVERAGE_PENDING = Object.freeze({ status: "unknown", reason: "audit_pending", requirements: [] });

/** @type {WeakMap<object, object>} taskRun → verification before coverage */
const baselines = new WeakMap();

function rememberBaseline(taskRun, verification) {
  if (taskRun && verification && typeof verification === "object") baselines.set(taskRun, { ...verification });
}

/**
 * A copy of what the audit reads, taken while it is still this turn's: the
 * session state object is reused by the next turn.
 */
function auditSnapshot(state = {}) {
  return { ...state, tools: new Map(state.tools || []) };
}

function report(site, error, snapshot) {
  require("./diagnostics/swallowed-failure").recordSwallowedFailure(site, error, {
    turn: snapshot?.turnId || "",
    session: snapshot?.sessionId || "",
  });
}

async function amendTurnRecord(ctx, sessionId, turnId, taskRun) {
  const manager = ctx?.sessionManager;
  if (typeof manager?.getAssistantForTurnAsync !== "function" || typeof manager?.updateMessageRecordMeta !== "function") return false;
  const message = await manager.getAssistantForTurnAsync(sessionId, turnId);
  if (!message?.id) return false;
  const { compactTaskRun } = require("./task-run-state");
  return Boolean(manager.updateMessageRecordMeta(sessionId, message.id, (meta) => ({ ...meta, taskRun: compactTaskRun(taskRun) })));
}

/**
 * Apply a late verdict to the turn it belongs to.
 * @returns {Promise<{ amended: boolean, reason: string, from?: string, to?: string }>}
 */
async function amendObjectiveCoverage({ ctx = {}, sessionId, snapshot, coverage } = {}) {
  const taskRun = snapshot?.taskRun;
  const baseline = taskRun ? baselines.get(taskRun) : null;
  if (!taskRun || !baseline) return { amended: false, reason: "no_baseline" };
  if (!coverage || coverage.status === "not_required" || coverage.status === "unknown") {
    // Unknown is what delivery already recorded; there is nothing to change.
    return { amended: false, reason: coverage?.reason || "unknown" };
  }
  const acceptance = require("./task-original-acceptance");
  const { completeTaskRun } = require("./task-run-state");
  const from = String(taskRun.verification?.status || "");
  const fromReason = String(taskRun.verification?.reason || "");
  const verification = acceptance.applyObjectiveCoverage({ ...baseline }, coverage);
  verification.objectiveCoverage = coverage;
  completeTaskRun(taskRun, "turn.completed", verification);
  const to = String(taskRun.verification?.status || "");
  if (to === from && String(taskRun.verification?.reason || "") === fromReason) {
    return { amended: false, reason: "unchanged" };
  }
  const lifecycle = require("./task-lifecycle-runtime").amendTaskLifecycleVerification(ctx, sessionId, snapshot, {
    fromStatus: from,
    verification: taskRun.verification,
    amendedBy: "objective_coverage",
  });
  let recordAmended = false;
  try {
    recordAmended = await amendTurnRecord(ctx, sessionId, snapshot.turnId, taskRun);
  } catch (error) {
    report("objective coverage record amendment", error, snapshot);
  }
  log.info(
    "verdict amended after delivery: %s -> %s (coverage=%s, lifecycle=%s, record=%s) turn=%s",
    from, to, coverage.status, lifecycle?.ok ? "ok" : lifecycle?.reason || "skipped", recordAmended ? "ok" : "skipped", snapshot.turnId || "-",
  );
  return { amended: true, reason: "", from, to };
}

/**
 * Run the audit without holding the answer, and amend the verdict when it lands.
 * Never throws; every way it can go wrong is reported, not swallowed.
 */
function auditAfterDelivery({ ctx = {}, sessionId, state, assess }) {
  const snapshot = auditSnapshot(state);
  return Promise.resolve()
    .then(() => assess({ state: snapshot }))
    .catch((error) => { report("objective coverage audit", error, snapshot); return null; })
    .then((coverage) => (coverage ? amendObjectiveCoverage({ ctx, sessionId, snapshot, coverage }) : { amended: false, reason: "no_verdict" }))
    .catch((error) => { report("objective coverage amendment", error, snapshot); return { amended: false, reason: "amendment_failed" }; });
}

module.exports = {
  COVERAGE_PENDING,
  amendObjectiveCoverage,
  auditAfterDelivery,
  auditSnapshot,
  rememberBaseline,
};
