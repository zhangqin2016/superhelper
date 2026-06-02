"use strict";

/**
 * @deprecated Use turn-controller.js — thin re-export for legacy imports.
 */
const { turnController, emitTurnState } = require("./turn-controller");

class SessionTurnState {
  begin(sessionId) {
    turnController.beginTurn(sessionId);
  }

  setPhase(sessionId, phase) {
    turnController.setPhase(sessionId, phase);
  }

  has(sessionId) {
    return turnController.has(sessionId);
  }

  append(sessionId, text) {
    return turnController.appendOutput(sessionId, text);
  }

  getOutput(sessionId) {
    return turnController.getOutput(sessionId);
  }

  end(sessionId) {
    const { output, wasActive } = turnController.completeTurn(sessionId, "completed");
    turnController.finalizeTurn(sessionId);
    return wasActive ? output : turnController.getOutput(sessionId);
  }

  abort(sessionId) {
    turnController.completeTurn(sessionId, "interrupted");
    turnController.finalizeTurn(sessionId);
  }

  getRunningSessionIds(_runnerPool) {
    return turnController.getRunningSessionIds();
  }

  snapshot(sessionId, _runnerPool) {
    const snap = turnController.snapshot(sessionId);
    return {
      sessionId: snap.sessionId,
      active: snap.active,
      phase: snap.legacyPhase,
    };
  }
}

const turnState = new SessionTurnState();

module.exports = {
  SessionTurnState,
  turnState,
  emitTurnState,
};
