"use strict";

// Which event types end a turn and which may be emitted with no turn active
// are facts of the runtime contract (src/shared/runtime-contract.json), not of
// this file. The hand-kept lists here had drifted from it in both directions.
const { TERMINAL_EVENT_TYPES, TURN_OPTIONAL_TYPES } = require("./runtime-event-schema");

module.exports = {
  TERMINAL_TYPES: TERMINAL_EVENT_TYPES,
  TURN_OPTIONAL_TYPES,
};
