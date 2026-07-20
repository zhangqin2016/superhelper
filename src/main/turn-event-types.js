"use strict";

const TERMINAL_TYPES = new Set([
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.stalled",
]);

const TURN_OPTIONAL_TYPES = new Set([
  "session.hydrated",
  "resume.updated",
  "resume.invalid",
  "queue.updated",
  "user.committed",
  "turn.steered",
  "turn.self_heal_retry",
  "turn.self_heal_notice",
  "engine.notice",
  "engine.warning",
  "engine.stderr",
  "context.compactionDecision",
  "prompt_suggestions.updated",
]);

module.exports = {
  TERMINAL_TYPES,
  TURN_OPTIONAL_TYPES,
};
