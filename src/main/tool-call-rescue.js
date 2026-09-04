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
// rescue turn never chains into another rescue UNLESS the strategy explicitly
// allows multiple attempts (maxAttempts > 1, e.g. model_connection_retry —
// a gateway restart loop outlasts a single retry). The old 5-minute cooldown
// made a user's manual resend seconds after a failure get WORSE treatment
// than their first send (no rescue at all).
const COOLDOWN_MS = 5_000;
// Multi-attempt budgets reset after this gap: a failure episode ten minutes
// later is a NEW episode and earns a fresh set of silent attempts.
const ATTEMPT_WINDOW_MS = 10 * 60_000;

/** @type {Map<string, {at: number, count: number}>} `${sessionId}:${code}` -> attempts */
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

// CONTINUATION, not replay. The corrective hints above ride a REPLAY of the
// user's request, which is only safe when every tool that ran was replay-safe —
// so a long turn that had already edited files got no rescue at all and the
// user saw the raw failure. That is the reported case: 148 tool calls in, files
// already written, and the turn died because the model wrote its next call as
// text.
//
// Continuing the same engine session instead re-does nothing: the history and
// the files on disk are still there, and only the next action is asked for. The
// instruction to not redo completed work is explicit, because the alternative —
// the user resending the whole request by hand — redoes far more.
const CONTINUATION_HINT = [
  "[system correction] Your previous reply wrote a tool call as plain text (e.g. <tool_call>, <function=...>, <invoke name=...>, <parameter ...>, or a special-token form). Text like that is NOT executed — that step did not run.",
  "This is a CONTINUATION of the same task, not a restart. Follow these rules:",
  "1. Do NOT redo work you already completed. Files you already wrote are still written; steps you already finished are still finished.",
  "2. Take stock of where the task actually stands, then perform ONLY the next action that is still missing.",
  "3. To use a tool, emit a NATIVE structured tool/function call. Never write tool-call markup, XML, or raw JSON in your text reply.",
  "4. If nothing further needs a tool, just give the user the final answer or summary in plain text.",
].join("\n");

const CONTINUATION_HINT_ZH = [
  "[系统纠正] 你上一条回复把工具调用写成了纯文本（例如 <tool_call>、<function=...>、<invoke name=...>、<parameter ...>，或 ｜｜…｜｜ 之类的特殊 token 形式）。这类文本不会被执行——那一步没有真正发生。",
  "这是同一个任务的**继续**，不是重新开始。严格遵守：",
  "1. 不要重做你已经完成的工作。已经写好的文件仍然存在，已经完成的步骤仍然有效。",
  "2. 先确认任务当前的真实进度，然后只做还缺的那一步。",
  "3. 需要用工具时，必须通过工具调用接口发起原生的结构化调用，绝不要在文本里写工具调用标记、XML 或 JSON。",
  "4. 如果剩下的事不需要工具，就直接用纯文本给出最终答案或汇总。",
].join("\n");

function continuationHintFor(recipes = {}) {
  return recipes?.instructionLanguage === "zh" ? CONTINUATION_HINT_ZH : CONTINUATION_HINT;
}

/**
 * Should a leaked-tool-call failure be continued rather than replayed?
 *
 * Replay stays the default when it is safe, because replaying reproduces the
 * turn cleanly. Continuation exists for the case replay must refuse: a turn
 * that already had side effects. Kill switch: LILY_TOOL_CALL_CONTINUATION=0
 * restores the previous behaviour, where such a turn simply failed.
 */
function shouldContinueInsteadOfReplay(code, tools = []) {
  if (process.env.LILY_TOOL_CALL_CONTINUATION === "0") return false;
  if (String(code || "") !== "MALFORMED_TOOL_CALL_TEXT") return false;
  return !isSideEffectFreeToolRun(tools);
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
  // Model-service connection failures (2026-07-21 auto-repair directive):
  // upstream flakes (gateway restart, rolling deploy, keep-alive poisoning)
  // must be absorbed by the platform, never shown to the user while the API
  // is actually usable. recycleEngine gets fresh connections (same poisoned
  // pool reasoning as EMPTY_ASSISTANT_COMPLETION); the runtime additionally
  // hot-refreshes the model env before each attempt. Multi-attempt because a
  // gateway restart loop outlasts a single retry — bounded so a genuinely
  // dead service still ends in an honest, blame-free message.
  MODEL_CONNECTION_FAILED: Object.freeze({
    kind: "model_connection_retry",
    hint: "",
    recycleEngine: true,
    delayMs: 3000,
    maxAttempts: 3,
    enabled: () => process.env.LILY_MODEL_CONNECTION_RETRY !== "0",
  }),
  ENGINE_UNAVAILABLE: Object.freeze({
    kind: "model_connection_retry",
    hint: "",
    recycleEngine: true,
    delayMs: 4000,
    maxAttempts: 2,
    enabled: () => process.env.LILY_MODEL_CONNECTION_RETRY !== "0",
  }),
  MODEL_OVERLOADED: Object.freeze({
    kind: "model_connection_retry",
    hint: "",
    recycleEngine: true,
    delayMs: 8000,
    maxAttempts: 2,
    enabled: () => process.env.LILY_MODEL_CONNECTION_RETRY !== "0",
  }),
  RATE_LIMITED: Object.freeze({
    kind: "model_connection_retry",
    hint: "",
    recycleEngine: true,
    delayMs: 10000,
    maxAttempts: 2,
    enabled: () => process.env.LILY_MODEL_CONNECTION_RETRY !== "0",
  }),
  PERMISSION_DENIED: Object.freeze({
    kind: "model_connection_retry",
    hint: "",
    recycleEngine: true,
    delayMs: 2000,
    maxAttempts: 2,
    enabled: () => process.env.LILY_MODEL_CONNECTION_RETRY !== "0",
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

function shouldAttemptRescue(sessionId, code, now = Date.now(), maxAttempts = 1, debounceMs = COOLDOWN_MS) {
  const entry = lastRescueByKey.get(`${String(sessionId || "")}:${String(code || "")}`);
  if (!entry) return true;
  if (now - entry.at < debounceMs) return false;
  if (now - entry.at >= ATTEMPT_WINDOW_MS) return true;
  return (entry.count || 1) < (Number(maxAttempts) || 1);
}

function markRescueAttempt(sessionId, code, now = Date.now()) {
  const key = `${String(sessionId || "")}:${String(code || "")}`;
  const entry = lastRescueByKey.get(key);
  const count = entry && now - entry.at < ATTEMPT_WINDOW_MS ? (entry.count || 1) + 1 : 1;
  lastRescueByKey.set(key, { at: now, count });
}

/** Silent rescue attempts already spent for this session in the current window. */
function rescueAttemptCount(sessionId, now = Date.now()) {
  const prefix = `${String(sessionId || "")}:`;
  let total = 0;
  for (const [key, entry] of lastRescueByKey) {
    if (!key.startsWith(prefix) || now - entry.at >= ATTEMPT_WINDOW_MS) continue;
    total += entry.count || 0;
  }
  return total;
}

/** Test hook: reset per-session cooldowns. */
function resetRescueStateForTests() {
  lastRescueByKey.clear();
}

module.exports = {
  CORRECTIVE_HINT,
  CORRECTIVE_HINT_ZH,
  CONTINUATION_HINT,
  CONTINUATION_HINT_ZH,
  correctiveHintFor,
  continuationHintFor,
  shouldContinueInsteadOfReplay,
  evidenceVerifyHintFor,
  rescueStrategyFor,
  isRescuableFailureCode,
  isSideEffectFreeToolRun,
  shouldAttemptRescue,
  markRescueAttempt,
  rescueAttemptCount,
  resetRescueStateForTests,
};
