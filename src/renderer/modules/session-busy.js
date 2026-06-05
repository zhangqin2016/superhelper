/**
 * Per-session busy state — driven by assistant:runtime-events.
 */

import {
  canSend,
  canInterrupt,
  isSessionRunning,
  anySessionRunning,
  getTurnPhase,
  getTurnId,
  hydrateRuntimeFromState,
  isActiveSessionBusy,
} from "./session-runtime-store.js";

export {
  canSend,
  canInterrupt,
  isSessionRunning,
  anySessionRunning,
  getTurnPhase,
  getTurnId,
  isActiveSessionBusy,
};

export function applyTurnState(_payload) {}
export function setSessionRunning(_sessionId, _running) {}
export function enableTurnStoreDevCompare(_enabled = true) {}

export function syncRunningFromState(state) {
  hydrateRuntimeFromState(state);
}
