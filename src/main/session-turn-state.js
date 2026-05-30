"use strict";

const { appendTextSegment } = require("./agent-runner");

/**
 * Authoritative turn tracking in the main process.
 * UI busy/running must follow assistant:turn-state, not local guesses.
 */
class SessionTurnState {
  constructor() {
    /** @type {Set<string>} */
    this.activeTurns = new Set();
    /** @type {Map<string, string>} */
    this.turnOutputs = new Map();
    /** @type {Map<string, string>} */
    this.phases = new Map();
  }

  /** @param {string} sessionId */
  begin(sessionId) {
    this.activeTurns.add(sessionId);
    this.turnOutputs.set(sessionId, "");
    this.phases.set(sessionId, "starting");
  }

  /**
   * @param {string} sessionId
   * @param {string} phase starting | active | permission | tool | idle
   */
  setPhase(sessionId, phase) {
    if (!sessionId) return;
    if (phase === "idle") {
      this.phases.delete(sessionId);
      return;
    }
    if (this.activeTurns.has(sessionId) || phase !== "idle") {
      this.phases.set(sessionId, phase);
    }
  }

  /** @param {string} sessionId */
  has(sessionId) {
    return this.activeTurns.has(sessionId);
  }

  /** @param {string} sessionId */
  append(sessionId, text) {
    const prev = this.turnOutputs.get(sessionId) || "";
    const next = appendTextSegment(prev, text);
    this.turnOutputs.set(sessionId, next);
    return next;
  }

  /** @param {string} sessionId */
  getOutput(sessionId) {
    return this.turnOutputs.get(sessionId) || "";
  }

  /**
   * @param {string} sessionId
   * @returns {string} accumulated output
   */
  end(sessionId) {
    const output = this.turnOutputs.get(sessionId) || "";
    this.activeTurns.delete(sessionId);
    this.turnOutputs.delete(sessionId);
    this.phases.delete(sessionId);
    return output;
  }

  /** @param {string} sessionId */
  abort(sessionId) {
    this.end(sessionId);
  }

  /**
   * @param {import("./session-runner-pool").SessionRunnerPool} runnerPool
   */
  getRunningSessionIds(runnerPool) {
    const ids = new Set(this.activeTurns);
    for (const sessionId of runnerPool.getSessionIds()) {
      if (runnerPool.get(sessionId)?.isBusy()) ids.add(sessionId);
    }
    return [...ids];
  }

  /**
   * @param {string} sessionId
   * @param {import("./session-runner-pool").SessionRunnerPool | null | undefined} runnerPool
   */
  snapshot(sessionId, runnerPool) {
    const runner = runnerPool?.get(sessionId);
    const inRegistry = this.activeTurns.has(sessionId);
    const runnerBusy = Boolean(runner?.isBusy());
    const active = inRegistry || runnerBusy;
    let phase = this.phases.get(sessionId) || "idle";
    if (active && phase === "idle") {
      phase = runnerBusy ? "active" : "starting";
    }
    return { sessionId, active, phase };
  }
}

const turnState = new SessionTurnState();

/**
 * @param {{ mainWindow?: import('electron').BrowserWindow | null, runnerPool?: import('./session-runner-pool').SessionRunnerPool }} ctx
 * @param {string} sessionId
 */
function emitTurnState(ctx, sessionId) {
  if (!sessionId || !ctx?.mainWindow) return;
  const payload = turnState.snapshot(sessionId, ctx.runnerPool);
  if (ctx.mainWindow.isDestroyed()) return;
  ctx.mainWindow.webContents.send("assistant:turn-state", payload);
}

module.exports = { SessionTurnState, turnState, emitTurnState };
