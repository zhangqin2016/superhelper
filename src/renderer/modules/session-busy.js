/**
 * Per-session busy state — reads from turn-store (IPC-driven).
 */

import {
  applyTurnState,
  canSend,
  canInterrupt,
  isSessionRunning,
  anySessionRunning,
  getTurnPhase,
  hydrateTurnStoreFromState,
  isActiveSessionBusy,
  enableTurnStoreDevCompare,
} from "./turn-store.js";

export {
  applyTurnState,
  canSend,
  canInterrupt,
  isSessionRunning,
  anySessionRunning,
  getTurnPhase,
  hydrateTurnStoreFromState,
  isActiveSessionBusy,
  enableTurnStoreDevCompare,
};

/** @deprecated Busy is driven by assistant:turn-state — no-op. */
export function setSessionRunning(_sessionId, _running) {}

export function syncRunningFromState(state) {
  hydrateTurnStoreFromState(state);
}
