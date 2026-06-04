/**
 * Renderer turn state — single source of truth from assistant:turn-state IPC.
 */

import store from "./state.js";

/** @typedef {"idle"|"sending"|"streaming"|"tool"|"permission"|"stopping"|"closing"} TurnPhase */

const MACHINE_PHASES = new Set([
  "idle",
  "sending",
  "streaming",
  "tool",
  "permission",
  "stopping",
  "closing",
]);

/** @type {Map<string, object>} */
const states = new Map();

let devCompareEnabled = false;

/** Enable dual-write comparison logs (development). */
export function enableTurnStoreDevCompare(enabled = true) {
  devCompareEnabled = Boolean(enabled);
}

function normalizePhase(payload) {
  if (MACHINE_PHASES.has(payload.phase)) return payload.phase;
  switch (payload.phase) {
    case "starting":
      return "sending";
    case "active":
      return "streaming";
    case "tool":
      return "tool";
    case "permission":
      return "permission";
    default:
      return payload.active ? "streaming" : "idle";
  }
}

function logDevMismatch(sessionId, legacyRunning) {
  if (!devCompareEnabled) return;
  const fromStore = isSessionRunning(sessionId);
  if (fromStore !== legacyRunning) {
    console.warn(
      "[turn-store] busy mismatch",
      sessionId,
      { turnStore: fromStore, legacyRunning, snap: states.get(sessionId) },
    );
  }
}

/**
 * @param {object} payload assistant:turn-state IPC payload
 */
export function applyTurnState(payload) {
  if (!payload?.sessionId) return;
  const sessionId = payload.sessionId;
  const prev = states.get(sessionId);
  if (
    prev &&
    typeof payload.seq === "number" &&
    typeof prev.seq === "number" &&
    payload.seq < prev.seq
  ) {
    return;
  }

  const phase = normalizePhase(payload);
  const entry = {
    v: payload.v ?? 1,
    sessionId,
    turnId: payload.turnId ?? null,
    phase,
    active: payload.active ?? phase !== "idle",
    canSend: payload.canSend ?? phase === "idle",
    canInterrupt:
      payload.canInterrupt ?? (phase !== "idle" && phase !== "stopping"),
    endReason: payload.endReason,
    seq: payload.seq ?? (prev?.seq ?? 0) + 1,
  };
  states.set(sessionId, entry);

  if (devCompareEnabled && typeof payload.active === "boolean") {
    logDevMismatch(sessionId, payload.active);
  }
}

/** Seed from state:full on startup (until first turn-state arrives). */
export function hydrateTurnStoreFromState(state) {
  const ids = new Set();
  for (const project of state?.projects || []) {
    for (const session of project.sessions || []) {
      if (session.status === "running") ids.add(session.id);
    }
  }
  for (const sessionId of ids) {
    if (!states.has(sessionId)) {
      applyTurnState({
        sessionId,
        phase: "streaming",
        active: true,
        canSend: false,
        canInterrupt: true,
        seq: 0,
      });
    }
  }
}

/** @param {string | null | undefined} sessionId */
export function getTurnPhase(sessionId) {
  if (!sessionId) return "idle";
  return states.get(sessionId)?.phase ?? "idle";
}

/** @param {string | null | undefined} sessionId */
export function getTurnId(sessionId) {
  if (!sessionId) return null;
  return states.get(sessionId)?.turnId ?? null;
}

/** @param {string | null | undefined} sessionId */
export function canSend(sessionId) {
  if (!sessionId) return true;
  const entry = states.get(sessionId);
  return entry ? entry.canSend : true;
}

/** @param {string | null | undefined} sessionId */
export function canInterrupt(sessionId) {
  if (!sessionId) return false;
  const entry = states.get(sessionId);
  return entry ? entry.canInterrupt : false;
}

/** @param {string | null | undefined} sessionId */
export function isSessionRunning(sessionId) {
  if (!sessionId) return false;
  const entry = states.get(sessionId);
  return entry ? entry.phase !== "idle" : false;
}

export function anySessionRunning() {
  for (const entry of states.values()) {
    if (entry.phase !== "idle") return true;
  }
  return false;
}

export function isActiveSessionBusy() {
  return !canSend(store.get("activeSessionId"));
}
