"use strict";

/**
 * A round Lily is still running is its live card, not history.
 *
 * The engine keeps a running round as ordinary assistant messages — one per
 * model step, each "completed" as it ends — so its history cannot say the round
 * is unfinished. Surfaced as history, a running round reads as a finished
 * answer: 2026-09-24, every switch back into a session mid-task added one more
 * "耗时 823s · 11.8k tokens" card of partial narration under the real answer.
 *
 * The round is identified by TIME, not by the turn id binding. Binding goes
 * through the round's user message, and a history page is the newest 50
 * engine messages: a long round (156 steps that day) pushes its own question
 * out of the page, nothing binds, and a turn-id filter lets every step through
 * — the first version of this fix, which held for short rounds only. Lily and
 * the engine share this machine's clock, and everything the engine wrote since
 * the running turn started belongs to that turn.
 */
function runningRound(ctx, sessionId) {
  try {
    const snapshot = ctx.turnOrchestrator?.snapshot?.(sessionId);
    if (!snapshot || !snapshot.phase || snapshot.phase === "idle") return null;
    return { turnId: String(snapshot.turnId || ""), startedAt: Number(snapshot.turnStartedAt) || 0 };
  } catch {
    return null;
  }
}

// A step written a moment before the host stamped the turn (the engine starts
// on the prompt the host just sent) is still this round.
const CLOCK_SLACK_MS = 2_000;

function messageStartedAt(message = {}) {
  const started = Number(message.record?.startedAt);
  if (Number.isFinite(started) && started > 0) return started;
  const parsed = Date.parse(message.timestamp || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function withoutRunningRound(conversation, ctx, sessionId) {
  const round = runningRound(ctx, sessionId);
  if (!round) return conversation;
  return conversation.filter((message) => {
    if (message.role !== "assistant") return true;
    if (round.turnId && message.turnId === round.turnId) return false;
    return !(round.startedAt && messageStartedAt(message) >= round.startedAt - CLOCK_SLACK_MS);
  });
}

module.exports = { runningRound, withoutRunningRound };
