"use strict";

const ACTIVE_TURN_PHASES = new Set([
  "running",
  "streaming",
  "tool_running",
  "awaiting_user",
]);

function isActiveTurnPhase(phase) {
  return ACTIVE_TURN_PHASES.has(phase);
}

module.exports = { ACTIVE_TURN_PHASES, isActiveTurnPhase };
