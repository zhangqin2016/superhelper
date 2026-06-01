"use strict";

const crypto = require("node:crypto");
const { appendTextSegment } = require("./agent-runner");

/** @typedef {"idle"|"sending"|"streaming"|"tool"|"permission"|"stopping"} TurnPhase */
/** @typedef {"completed"|"interrupted"|"stalled"|"error"|"send_failed"} TurnEndReason */

const CAPS = {
  idle: { canSend: true, canInterrupt: false },
  sending: { canSend: false, canInterrupt: true },
  streaming: { canSend: false, canInterrupt: true },
  tool: { canSend: false, canInterrupt: true },
  permission: { canSend: false, canInterrupt: true },
  stopping: { canSend: false, canInterrupt: false },
};

function emptySession() {
  return {
    turnId: null,
    phase: "idle",
    seq: 0,
    output: "",
    pendingTools: 0,
    endReason: null,
  };
}

function legacyPhase(phase) {
  switch (phase) {
    case "sending":
      return "starting";
    case "streaming":
    case "stopping":
      return "active";
    case "tool":
      return "tool";
    case "permission":
      return "permission";
    default:
      return "idle";
  }
}

class TurnController {
  constructor() {
    /** @type {Map<string, ReturnType<typeof emptySession>>} */
    this._sessions = new Map();
  }

  /** @param {string} sessionId */
  _ensure(sessionId) {
    if (!this._sessions.has(sessionId)) {
      this._sessions.set(sessionId, emptySession());
    }
    return this._sessions.get(sessionId);
  }

  /** @param {string} sessionId */
  _bump(sessionId) {
    const s = this._ensure(sessionId);
    s.seq += 1;
    return s;
  }

  /**
   * @param {string} sessionId
   * @returns {string} turnId
   */
  beginTurn(sessionId) {
    const s = this._bump(sessionId);
    s.turnId = crypto.randomUUID();
    s.phase = "sending";
    s.output = "";
    s.pendingTools = 0;
    s.endReason = null;
    return s.turnId;
  }

  /**
   * @param {string} sessionId
   * @param {string} event
   * @param {{ reason?: TurnEndReason }} [meta]
   */
  transition(sessionId, event, meta = {}) {
    const s = this._ensure(sessionId);
    if (s.phase === "idle" && event !== "userSend") {
      return null;
    }

    switch (event) {
      case "userSend":
        return this.beginTurn(sessionId);
      case "sendFailed":
        return this._toIdle(sessionId, meta.reason || "send_failed");
      case "engineAccepted":
        if (s.phase === "sending") {
          s.phase = "streaming";
          this._bump(sessionId);
        }
        return s.turnId;
      case "toolStart":
        s.pendingTools += 1;
        s.phase = "tool";
        this._bump(sessionId);
        return s.turnId;
      case "toolEnd":
        s.pendingTools = Math.max(0, s.pendingTools - 1);
        if (s.phase === "tool" || s.phase === "streaming" || s.phase === "permission") {
          s.phase = s.pendingTools > 0 ? "tool" : "streaming";
          this._bump(sessionId);
        }
        return s.turnId;
      case "permissionRequest":
        s.phase = "permission";
        this._bump(sessionId);
        return s.turnId;
      case "permissionResolved":
        if (s.phase === "permission") {
          s.phase = s.pendingTools > 0 ? "tool" : "streaming";
          this._bump(sessionId);
        }
        return s.turnId;
      case "userInterrupt":
        if (s.phase !== "idle") {
          s.phase = "stopping";
          this._bump(sessionId);
        }
        return s.turnId;
      case "interruptDone":
        return this._toIdle(sessionId, meta.reason || "interrupted");
      case "turnComplete":
        return this._toIdle(
          sessionId,
          meta.reason ||
            (meta.interrupted ? "interrupted" : meta.stalled ? "stalled" : "completed"),
        );
      case "engineError":
        return this._toIdle(sessionId, meta.reason || "error");
      default:
        return s.turnId;
    }
  }

  /**
   * @param {string} sessionId
   * @param {TurnEndReason} reason
   */
  _toIdle(sessionId, reason) {
    const s = this._ensure(sessionId);
    const turnId = s.turnId;
    const output = s.output;
    s.turnId = null;
    s.phase = "idle";
    s.pendingTools = 0;
    s.endReason = reason;
    this._bump(sessionId);
    return { turnId, output };
  }

  /**
   * End turn and return accumulated output (done handler).
   * @param {string} sessionId
   * @param {TurnEndReason} reason
   */
  completeTurn(sessionId, reason) {
    const s = this._ensure(sessionId);
    if (s.phase === "idle") {
      return { turnId: null, output: s.output, wasActive: false };
    }
    const { turnId, output } = this._toIdle(sessionId, reason);
    return { turnId, output, wasActive: true };
  }

  /** Force idle (e.g. interrupt when runner already settled). */
  forceIdle(sessionId, reason = "interrupted") {
    const s = this._ensure(sessionId);
    if (s.phase === "idle") {
      return { turnId: null, output: s.output, wasActive: false };
    }
    const result = this._toIdle(sessionId, reason);
    return { ...result, wasActive: true };
  }

  /** @param {string} sessionId */
  has(sessionId) {
    return this._ensure(sessionId).phase !== "idle";
  }

  /** @param {string} sessionId */
  getTurnId(sessionId) {
    return this._ensure(sessionId).turnId;
  }

  /** @param {string} sessionId */
  appendOutput(sessionId, text) {
    const s = this._ensure(sessionId);
    s.output = appendTextSegment(s.output, text);
    return s.output;
  }

  /** @param {string} sessionId */
  getOutput(sessionId) {
    return this._ensure(sessionId).output || "";
  }

  /** @param {string} sessionId */
  abort(sessionId) {
    return this.completeTurn(sessionId, "interrupted");
  }

  /**
   * Legacy API — maps to transition.
   * @param {string} sessionId
   * @param {string} phase
   */
  setPhase(sessionId, phase) {
    if (phase === "permission") {
      this.transition(sessionId, "permissionRequest");
    } else if (phase === "active" || phase === "starting") {
      if (this._ensure(sessionId).phase === "sending") {
        this.transition(sessionId, "engineAccepted");
      }
    } else if (phase === "idle") {
      this.forceIdle(sessionId, "completed");
    }
  }

  /** @param {string} sessionId */
  snapshot(sessionId) {
    const s = this._ensure(sessionId);
    const caps = CAPS[s.phase] || CAPS.idle;
    return {
      v: 1,
      sessionId,
      turnId: s.turnId,
      phase: s.phase,
      active: s.phase !== "idle",
      canSend: caps.canSend,
      canInterrupt: caps.canInterrupt,
      endReason: s.phase === "idle" ? s.endReason || undefined : undefined,
      seq: s.seq,
      // legacy fields for gradual migration
      legacyPhase: legacyPhase(s.phase),
    };
  }

  getRunningSessionIds() {
    const ids = [];
    for (const [sessionId, s] of this._sessions) {
      if (s.phase !== "idle") ids.push(sessionId);
    }
    return ids;
  }
}

const turnController = new TurnController();

/**
 * @param {{ mainWindow?: import('electron').BrowserWindow | null }} ctx
 * @param {string} sessionId
 */
function emitTurnState(ctx, sessionId) {
  if (!sessionId || !ctx?.mainWindow || ctx.mainWindow.isDestroyed()) return;
  const snap = turnController.snapshot(sessionId);
  ctx.mainWindow.webContents.send("assistant:turn-state", {
    v: snap.v,
    sessionId: snap.sessionId,
    turnId: snap.turnId,
    phase: snap.phase,
    legacyPhase: snap.legacyPhase,
    active: snap.active,
    canSend: snap.canSend,
    canInterrupt: snap.canInterrupt,
    endReason: snap.endReason,
    seq: snap.seq,
  });
}

module.exports = {
  TurnController,
  turnController,
  emitTurnState,
  legacyPhase,
};
