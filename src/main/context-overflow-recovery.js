"use strict";

/**
 * When the provider refuses a request because the conversation no longer fits.
 *
 * An overflow is the one moment the model's real window is measured instead of
 * assumed, and the one failure compaction is made for. Lily used to answer it
 * the other way round: the engine reported the overflow while it was already
 * compacting and replaying the request, and Lily failed the turn on that very
 * report; a visible overflow discarded the engine session — the whole
 * conversation — and a same-turn replay restarted in a blank one. Now:
 *
 *  - an overflow the engine compacts away itself is not a failure (it teaches
 *    the window and the turn goes on);
 *  - a visible overflow teaches the window (the limit the error names, else the
 *    largest request this model accepted), is recorded on the session so the
 *    next turn compacts first, and keeps the conversation;
 *  - only a second overflow that compaction did not resolve falls back to the
 *    previous behaviour (a fresh engine session).
 *
 * Kill switch: LILY_CONTEXT_OVERFLOW_RECOVERY=0 restores the previous handling.
 */

const { getLogger } = require("./logger");

const log = getLogger("context-overflow");

// The size a provider refused as bytes, not tokens — raw attachment bytes, not
// conversation length. Those keep the attachment-manifest replay.
const PAYLOAD_SIZE_RE = /request entity too large|payload too large|body too large|entity too large|\b413\b/i;

function enabled() {
  return process.env.LILY_CONTEXT_OVERFLOW_RECOVERY !== "0";
}

function modelIdentity(runner) {
  const options = runner?.spawnOptions || {};
  return {
    baseUrl: options.modelRouteAudit?.baseUrl || options.env?.LILY_API_BASE_URL || "",
    modelId: options.model?.modelID || "",
  };
}

/** A conversation too long for the model — not an upload too large for the gateway. */
function isTokenWindowOverflow(classified, raw = "") {
  return classified?.code === "CONTEXT_LIMIT" && !PAYLOAD_SIZE_RE.test(String(raw || ""));
}

/** A request of this size just succeeded: the window is at least that large. */
function noteAcceptedUsage(runner, usage = {}) {
  try {
    const tokens = (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_input_tokens) || 0)
      + (Number(usage.cache_creation_input_tokens) || 0) + (Number(usage.output_tokens) || 0);
    if (!tokens || !runner) return;
    runner._contextHighWater = Math.max(Number(runner._contextHighWater) || 0, tokens);
    const { baseUrl, modelId } = modelIdentity(runner);
    const raised = require("./model-context-window").observeAcceptedRequest(baseUrl, modelId, tokens);
    if (raised) log.info(`context window ceiling raised: model=${modelId} window>=${raised}`);
  } catch (err) {
    log.warn(`accepted-usage bookkeeping failed open: ${err?.message || err}`);
  }
}

function learn(runner, classified, raw) {
  const { baseUrl, modelId } = modelIdentity(runner);
  return require("./model-context-window").learnFromOverflowFailure({
    classified, raw, baseUrl, modelId, acceptedTokens: Number(runner?._contextHighWater) || 0,
  });
}

function engineCompactsOnOverflow(runner) {
  try {
    const config = JSON.parse(runner?.activeEngineConfig?.() || "{}");
    return config?.compaction?.auto !== false;
  } catch {
    return false;
  }
}

/**
 * The engine reported an overflow it is compacting away itself (it compacts,
 * then replays the request). Not a turn failure: learn from it and let the turn
 * continue. A compaction that itself failed arrives flagged and is not absorbed.
 */
function absorbEngineOverflow(runner, effect = {}) {
  if (!enabled() || effect.compactionFailed || effect.cause?.name !== "ContextOverflowError") return false;
  if (!engineCompactsOnOverflow(runner)) return false;
  const raw = String(effect.message || effect.cause?.data?.message || "");
  let learned = 0;
  try {
    learned = learn(runner, { code: "CONTEXT_LIMIT" }, raw);
  } catch (err) {
    log.warn(`window learning from an engine overflow failed open: ${err?.message || err}`);
  }
  log.warn(`engine reported a context overflow and is compacting before it retries: session=${runner?.sessionId || "-"} model=${modelIdentity(runner).modelId || "-"} learnedWindow=${learned || "none"} error=${raw.slice(0, 200)}`);
  return true;
}

/**
 * A visible overflow: learn, record it on the session so the next turn
 * compacts first, and say whether the conversation can be kept. It cannot when
 * an earlier overflow was never followed by a compaction — that is the case
 * the fresh session was always the answer to.
 */
function onVisibleFailure(runner, classified, raw = "") {
  if (!enabled() || !isTokenWindowOverflow(classified, raw)) return { keepConversation: false };
  let learned = 0;
  try {
    learned = learn(runner, classified, raw);
  } catch (err) {
    log.warn(`window learning from a visible overflow failed open: ${err?.message || err}`);
  }
  const sessionId = runner?.sessionId || "";
  let unresolvedBefore = false;
  try {
    const memory = require("./session-memory");
    const previous = memory.readSessionSummary(sessionId) || { schemaVersion: 1, sessionId, turnCount: 0, recentUserIntents: [], recentFiles: [] };
    unresolvedBefore = require("./context-budget-manager").unresolvedContextOverflow(previous);
    const at = new Date().toISOString();
    memory.writeSessionSummary(sessionId, {
      ...previous, updatedAt: at, lastContextOverflowAt: at,
      contextOverflowCount: Number(previous.contextOverflowCount || 0) + 1,
      contextOverflowRetryable: !unresolvedBefore,
    });
  } catch (err) {
    log.warn(`recording the overflow failed open (the next turn will not force compaction): ${err?.message || err}`);
    return { keepConversation: false, learned };
  }
  const keepConversation = !unresolvedBefore;
  log.warn(`context overflow: session=${sessionId} model=${modelIdentity(runner).modelId || "-"} learnedWindow=${learned || "none"} ${keepConversation ? "keeping the conversation; the next turn compacts first" : "a previous overflow was never compacted away; starting a fresh engine session"}`);
  return { keepConversation, learned };
}

/**
 * May the failed turn be retried? Once per overflow: the session kept its
 * conversation, the overflow is on record and nothing has compacted it yet.
 * A retry that overflows again is recorded as not retryable.
 */
function retryReady(sessionId) {
  if (!enabled() || !sessionId) return false;
  try {
    const summary = require("./session-memory").readSessionSummary(sessionId) || {};
    return summary.contextOverflowRetryable === true && require("./context-budget-manager").unresolvedContextOverflow(summary);
  } catch (err) {
    log.warn(`overflow retry check failed open (no retry): ${err?.message || err}`);
    return false;
  }
}

/**
 * A same-turn replay of an overflow restarts in a blank engine session. With
 * no attachments to swap for a manifest there is nothing else it changes, so
 * the overflow goes to the visible path instead: kept conversation, compaction,
 * and the rescue retry.
 */
function preferCompactionOverReplay(runner, classified, raw = "") {
  if (!enabled() || !isTokenWindowOverflow(classified, raw)) return false;
  const files = runner?._pendingPromptPayload?.files;
  return !(Array.isArray(files) && files.length);
}

module.exports = {
  absorbEngineOverflow,
  isTokenWindowOverflow,
  noteAcceptedUsage,
  onVisibleFailure,
  preferCompactionOverReplay,
  retryReady,
};
