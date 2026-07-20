"use strict";

const { buildEvidenceRecoveryHint } = require("./external-evidence-recovery");
const { isSideEffectFreeToolRun } = require("./tool-semantics");

/**
 * Turn rescue (turn 级救援) — immediate, silent retry-once for turn failures
 * that a retry plausibly fixes WITHOUT any config change:
 *
 * - MALFORMED_TOOL_CALL_TEXT: weak models (Qwen-family gateways are the
 *   canonical case) leak their tool call as literal text (`<tool_call>` /
 *   `<function=...>` markup) instead of emitting a native structured call.
 *   A re-probe cannot fix model BEHAVIOR — but a one-line corrective
 *   instruction usually can: these models follow explicit corrections far
 *   better than abstract schemas. Retry carries the corrective hint on the
 *   ENGINE-facing text (the visible transcript is untouched).
 *
 * - EMPTY_ASSISTANT_COMPLETION: the classic zero-chunk / gateway-flake death.
 *   When it is transient, an immediate plain retry absorbs it invisibly; when
 *   it is deterministic (gateway defect), the retry fails once and the
 *   existing self-heal probe path takes over.
 *
 * Capability-gate guard rails (Rule 13):
 * - kill switches: LILY_TOOL_CALL_RESCUE=0 (malformed),
 *   LILY_EMPTY_COMPLETION_RETRY=0 (empty), LILY_EVIDENCE_VERIFY_RETRY=0
 *   (all evidence retries), LILY_EXTERNAL_FACT_VERIFY_RETRY=0 (external facts)
 * - side-effect guard: rescue only fires when every executed tool is replay-safe
 *   (reads or recognized bundled research). Replaying a turn that already sent
 *   mail, edited files, or ran an arbitrary shell command remains prohibited
 * - per-session-per-code cooldown: a model that never recovers costs exactly
 *   one extra attempt per window, then falls through to the normal failure UX
 * - fail-open: any internal error leaves the normal failure flow untouched
 */

// Pure double-fire debounce. Loop prevention does NOT live here: a failed
// rescue turn never chains into another rescue (the orchestrator's
// wasRescueAttempt guard), so every USER action gets at most one silent
// retry. The old 5-minute cooldown made a user's manual resend seconds after
// a failure get WORSE treatment than their first send (no rescue at all).
const COOLDOWN_MS = 5_000;

/** @type {Map<string, number>} `${sessionId}:${code}` -> last attempt ts */
const lastRescueByKey = new Map();

const CORRECTIVE_HINT = [
  "[system correction] Your previous reply wrote a tool call as plain text — any tool-call markup in the text channel (e.g. <tool_call>, <function=...>, <invoke name=...>, <parameter ...>, or special-token forms like ｜｜…｜｜). That text is NOT executed — nothing happened.",
  "Retry now and follow these rules strictly:",
  "1. To use a tool, emit a NATIVE structured tool/function call through the tool-calling interface. Never write tool-call markup, XML, or raw JSON inside your text reply.",
  "2. Make one tool call at a time and wait for its result before the next step.",
  "3. If you cannot make tool calls, answer the user directly in plain text, with no tool markup at all.",
].join("\n");

const CORRECTIVE_HINT_ZH = [
  "[系统纠正] 你上一条回复把工具调用写成了纯文本——任何在正文里出现的工具调用标记（例如 <tool_call>、<function=...>、<invoke name=...>、<parameter ...>，或 ｜｜…｜｜ 之类的特殊 token 形式）。这些文本不会被执行——什么都没有发生。",
  "现在重试，并严格遵守：",
  "1. 需要使用工具时，必须通过工具调用接口发起原生的结构化调用，绝不能在文本回复里写工具调用标记、XML 或 JSON。",
  "2. 一次只调用一个工具，等拿到结果再进行下一步。",
  "3. 如果无法发起工具调用，就直接用纯文本回答用户，不要包含任何工具标记。",
].join("\n");

/** The corrective hint in the language the PROBE showed this model actually
 *  follows (capability.recipes.instructionLanguage). Default: English. */
function correctiveHintFor(recipes = {}) {
  return recipes?.instructionLanguage === "zh" ? CORRECTIVE_HINT_ZH : CORRECTIVE_HINT;
}

function evidenceVerifyHintFor(recipes = {}, context = {}) {
  const language = recipes?.instructionLanguage === "zh" ? "zh" : "en";
  return buildEvidenceRecoveryHint({ language, ...context });
}

// Per-code rescue strategy. `hint` (when set) rides the engine-facing text of
// the retried message; `enabled` reads the code's kill switch at call time.
const RESCUE_STRATEGIES = Object.freeze({
  MALFORMED_TOOL_CALL_TEXT: Object.freeze({
    kind: "tool_call_rescue",
    hint: CORRECTIVE_HINT,
    enabled: () => process.env.LILY_TOOL_CALL_RESCUE !== "0",
  }),
  // Evidence gate found unsupported strong claims → one silent retry that steers
  // the model to VERIFY with tools before asserting (verify-before-assert). Only
  // fires for side-effect-free turns (guarded by isSideEffectFreeToolRun), so a
  // turn that already wrote files/sent mail falls back to the caveat instead.
  // Available by default; the orchestrator decides WHEN to invoke it. High-risk
  // external facts verify by default when the turn was side-effect-free; other
  // ungrounded strong claims stay opt-in to avoid broadly replaying turns.
  // Hard-off with LILY_EVIDENCE_VERIFY_RETRY=0.
  EVIDENCE_UNVERIFIED: Object.freeze({
    kind: "evidence_verify_retry",
    hint: "",
    enabled: () => process.env.LILY_EVIDENCE_VERIFY_RETRY !== "0",
  }),
  // The document already exists, so this strategy continues with deterministic
  // delivery QA instead of replaying the user's authoring request. The
  // orchestrator supplies the exact artifact paths and runs full preflight so
  // the managed LibreOffice pack can become ready when needed.
  DOCUMENT_DELIVERY_UNVERIFIED: Object.freeze({
    kind: "document_verify_retry",
    hint: "",
    preflight: true,
    enabled: () => process.env.LILY_DOCUMENT_DELIVERY_RETRY !== "0",
  }),
  EMPTY_ASSISTANT_COMPLETION: Object.freeze({
    kind: "empty_completion_retry",
    hint: "",
    // Recycle the idle engine before the retry: empty completions from
    // load-balanced gateways are often a POISONED KEEP-ALIVE POOL (connection
    // affinity to a dead backend pod), so a same-process retry rides the same
    // dead socket. A fresh serve process gets fresh connections and resumes
    // the same engine session.
    recycleEngine: true,
    enabled: () => process.env.LILY_EMPTY_COMPLETION_RETRY !== "0",
  }),
  // Mid-turn stream truncation (final finish reason "unknown" after healthy
  // ones) — the gateway dropped the stream while the model was mid-task. A
  // plain retry re-runs the same request; the flake usually doesn't repeat.
  TRUNCATED_TURN_END: Object.freeze({
    kind: "truncated_turn_retry",
    hint: "",
    enabled: () => process.env.LILY_TRUNCATED_RETRY !== "0",
  }),
  // Micro-completion: a sentence-tail fragment leaked as the whole answer
  // (gateway thinking-mode glitch swallowing the body). A plain retry usually
  // gets the full response.
  MICRO_COMPLETION: Object.freeze({
    kind: "micro_completion_retry",
    hint: "",
    enabled: () => process.env.LILY_MICRO_COMPLETION_RETRY !== "0",
  }),
  // A terminated/recycled runner raced the send (idle restart, session
  // invalidation): the engine never started, so the turn is guaranteed
  // side-effect-free. preflight — the old runner is gone from the pool, so
  // the resend must run the full ensure path to build a fresh one (the other
  // strategies skip preflight because THEIR runner is proven alive).
  RUNNER_TERMINATED: Object.freeze({
    kind: "runner_terminated_retry",
    hint: "",
    preflight: true,
    enabled: () => process.env.LILY_RUNNER_TERMINATED_RETRY !== "0",
  }),
  // The engine process failed to start at preflight — the turn never reached
  // a model, so a resend is free of side effects by construction. delayMs
  // waits out the transient cause (port teardown, a dying previous serve,
  // slow disk) before the full-preflight resend rebuilds a fresh runner.
  RUNNER_ERROR: Object.freeze({
    kind: "runner_start_retry",
    hint: "",
    preflight: true,
    delayMs: 2000,
    enabled: () => process.env.LILY_RUNNER_START_RETRY !== "0",
  }),
});

// Tools whose re-execution is harmless (pure reads / research / planning).
// A rescue retry re-runs the WHOLE turn, so it is only dispatched when every
// tool the failed turn executed is on this list — replaying a turn that sent
// mail or edited files would be worse than failing honestly. Names are the
// engine's core tool names. MCP tools are deliberately NOT listed unless the
// host owns the implementation and can prove it is idempotent and external-
// side-effect-free; the intent-contract commit is that single internal case.
/** True when every executed tool is side-effect-free → a turn replay is safe. */
function rescueStrategyFor(code) {
  const strategy = RESCUE_STRATEGIES[String(code || "")] || null;
  if (!strategy || !strategy.enabled()) return null;
  return strategy;
}

function isRescuableFailureCode(code) {
  return Boolean(RESCUE_STRATEGIES[String(code || "")]);
}

function shouldAttemptRescue(sessionId, code, now = Date.now()) {
  const last = lastRescueByKey.get(`${String(sessionId || "")}:${String(code || "")}`) || 0;
  return now - last >= COOLDOWN_MS;
}

function markRescueAttempt(sessionId, code, now = Date.now()) {
  lastRescueByKey.set(`${String(sessionId || "")}:${String(code || "")}`, now);
}

/** Test hook: reset per-session cooldowns. */
function resetRescueStateForTests() {
  lastRescueByKey.clear();
}

module.exports = {
  CORRECTIVE_HINT,
  CORRECTIVE_HINT_ZH,
  correctiveHintFor,
  evidenceVerifyHintFor,
  rescueStrategyFor,
  isRescuableFailureCode,
  isSideEffectFreeToolRun,
  shouldAttemptRescue,
  markRescueAttempt,
  resetRescueStateForTests,
};
