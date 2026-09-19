"use strict";

const { failureCodeOf } = require("./turn-failure");

/**
 * Step-budget exhaustion — make "the model ran out of steps" a named, visible
 * stop instead of a clean completion.
 *
 * OpenCode caps a primary agent at `steps` model calls (160 by default). On
 * the last step it tells the model to wrap up and the turn ends with a normal
 * "stop" reason, so nothing downstream could tell "finished" from "ran out".
 * Lily counts steps per turn (one `usage.updated` per step) and, when the
 * budget is reached on a turn that was neither interrupted nor failed,
 * reports it as a stalled turn with a `budget_exhausted` continuation handoff
 * — the same shape the parent-closure lane already continues from.
 *
 * Kill switch: LILY_STEP_BUDGET_GUARD=0. Fail-open: any error → not exhausted.
 */

const MAX_OBJECTIVE_CHARS = 400;

const DEFAULT_STEP_BUDGET = 0; // 0 = no cap, matching opencode-config-builder.stepBudget

/**
 * The SAME budget the engine is configured with, or the guard fires at the
 * wrong step count. Zero means the engine has no cap (the default since
 * 2026-09-16), and `evaluateStepBudget` then never fires — the guard exists for
 * installations that re-arm the cap with LILY_OPENCODE_MAX_STEPS, where
 * exhausting it must hand off and continue rather than end the task. The
 * process env is read first because `resolveLilyEnv` needs the Electron app
 * context.
 */
function configuredStepBudget(env = process.env) {
  const direct = Number(env?.LILY_OPENCODE_MAX_STEPS);
  if (Number.isInteger(direct) && direct > 0) return direct;
  try {
    const { stepBudget } = require("./runtime/opencode-config-builder");
    const { resolveLilyEnv } = require("./spawn-env");
    return Number(stepBudget(resolveLilyEnv()).primary) || DEFAULT_STEP_BUDGET;
  } catch {
    return DEFAULT_STEP_BUDGET;
  }
}

function objectiveOf(state = {}) {
  const raw = state.taskContract?.intentContract?.objective
    || state.taskContract?.objective
    || state.enginePayload?.rawText
    || "";
  return String(raw || "").replace(/\s+/g, " ").trim().slice(0, MAX_OBJECTIVE_CHARS);
}

/**
 * @param {object} state turn state (reads `stepCount`, `taskContract`, `enginePayload`)
 * @param {object} payload engine completion payload
 * @param {{ budget?: number }} [options]
 * @returns {{ exhausted:boolean, count:number, budget:number, terminalMeta:object, notice:string }}
 */
function evaluateStepBudget(state = {}, payload = {}, options = {}) {
  const count = Number(state?.stepCount) || 0;
  const budget = Number(options.budget) || configuredStepBudget();
  const none = { exhausted: false, count, budget, terminalMeta: {}, notice: "", noticeIneligible: "" };
  try {
    if (process.env.LILY_STEP_BUDGET_GUARD === "0") return none;
    if (!(budget > 0) || count < budget) return none;
    if (payload?.interruptedByUser || payload?.userInterrupted || payload?.engineInterrupted || payload?.stalled) return none;
    if (payload?.failed || payload?.error || failureCodeOf(payload)) return none;
    const objective = objectiveOf(state);
    const handoff = payload?.continuationHandoff?.schemaVersion === 1
      ? payload.continuationHandoff
      : {
        schemaVersion: 1,
        reason: "budget_exhausted",
        progress: count,
        unfinished: objective ? [{ kind: "original_requirement", title: objective }] : [],
      };
    return {
      exhausted: true,
      count,
      budget,
      terminalMeta: {
        stepBudgetExhausted: { count, budget },
        continuationStopReason: "step_budget_exhausted",
        continuationHandoff: handoff,
      },
      notice: `本轮已用完 ${budget} 步的执行预算，任务尚未确认完成（已完成的步骤结果均已保留）。Lily 会自动接续一次；也可以直接说"继续"。`,
      // Used when the parent-closure gate refused: never promise a continuation
      // that will not come (the old unconditional text did).
      noticeIneligible: `本轮已用完 ${budget} 步的执行预算，任务尚未确认完成（已完成的步骤结果均已保留）。本轮不满足自动接续条件；直接说"继续"即可接着做。`,
    };
  } catch {
    return none;
  }
}

module.exports = { evaluateStepBudget, configuredStepBudget, MAX_OBJECTIVE_CHARS };
