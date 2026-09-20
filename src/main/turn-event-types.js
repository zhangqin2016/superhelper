"use strict";

// Which event types end a turn and which may be emitted with no turn active
// are facts of the runtime contract (src/shared/runtime-contract.json), not of
// this file. The hand-kept lists here had drifted from it in both directions.
const { TERMINAL_EVENT_TYPES, TURN_OPTIONAL_TYPES } = require("./runtime-event-schema");

function terminalTypeForWinner(winner, fallback) {
  if (TERMINAL_EVENT_TYPES.has(winner?.terminalType)) return winner.terminalType;
  switch (winner?.status) {
    case "completed": return "turn.completed";
    case "interrupted":
    case "cancelled": return "turn.interrupted";
    case "stalled": return "turn.stalled";
    case "failed": return "turn.failed";
    default: return fallback;
  }
}

module.exports = {
  terminalTypeForWinner,
  TERMINAL_TYPES: TERMINAL_EVENT_TYPES,
  TURN_OPTIONAL_TYPES,
};
