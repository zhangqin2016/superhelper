"use strict";

function resolvedOwnerScope(manager, session) {
  try {
    const resolved = manager._resolveCharacterOwnerScope(session);
    return typeof resolved === "string" && resolved ? resolved : null;
  } catch {
    return null;
  }
}

function admitTurnInput(sessionId, input = {}) {
  const session = this._find(sessionId);
  if (!session) return null;
  this._ensureImported(session);
  const ownerScope = resolvedOwnerScope(this, session);
  if (!ownerScope) {
    const error = new Error("OWNER_SCOPE_UNAVAILABLE");
    error.code = "OWNER_SCOPE_UNAVAILABLE";
    throw error;
  }
  const context = { ownerScope };
  return this._store().admitTurnInput(session.id, input, context);
}

function admitTurnInputFromSource(sessionId, input = {}, sourceTurnId = "") {
  const session = this._find(sessionId);
  if (!session) return null;
  this._ensureImported(session);
  const ownerScope = resolvedOwnerScope(this, session);
  if (!ownerScope) {
    const error = new Error("OWNER_SCOPE_UNAVAILABLE");
    error.code = "OWNER_SCOPE_UNAVAILABLE";
    throw error;
  }
  return this._store().admitTurnInput(session.id, input, {
    ownerScope,
    sourceTurnId: String(sourceTurnId || ""),
  });
}

function admitQueuedTurnInput(
  sessionId,
  input = {},
  queueRecoveryEnvelope = null,
  sourceTurnId = null,
) {
  const session = this._find(sessionId);
  if (!session) return null;
  this._ensureImported(session);
  const ownerScope = resolvedOwnerScope(this, session);
  if (!ownerScope) {
    return Object.freeze({
      ok: false,
      error: "OWNER_SCOPE_UNAVAILABLE",
      inserted: false,
      turn: null,
    });
  }
  const context = {
    ownerScope,
    queueRecoveryEnvelope,
  };
  if (typeof sourceTurnId === "string" && sourceTurnId) {
    context.sourceTurnId = sourceTurnId;
  }
  return this._store().admitQueuedTurnInput(session.id, input, context);
}

function claimTurnInputDispatch(sessionId, turnId, claim = {}) {
  const session = this._find(sessionId);
  if (!session || !turnId) return null;
  this._ensureImported(session);
  const ownerScope = resolvedOwnerScope(this, session);
  if (!ownerScope) {
    return Object.freeze({
      ok: false,
      reason: "OWNER_SCOPE_UNAVAILABLE",
      turn: null,
    });
  }
  if (
    typeof claim.ownerScope !== "string"
    || !claim.ownerScope
    || claim.ownerScope !== ownerScope
  ) {
    return Object.freeze({
      ok: false,
      reason: "OWNER_SCOPE_MISMATCH",
      turn: null,
    });
  }
  return this._store().claimTurnInputDispatch(session.id, turnId, {
    ...claim,
    ownerScope: claim.ownerScope,
  });
}

function markTurnInputPromoted(turnId, patch = {}) {
  return turnId ? this._store().markTurnInputPromoted(turnId, patch) : null;
}

function markTurnInputTerminal(claim = {}, terminalType, patch = {}) {
  const session = this._find(claim.sessionId);
  if (!session || !claim.turnId) {
    return Object.freeze({
      ok: false,
      reason: "NOT_FOUND",
      outcomeUnknown: false,
      turn: null,
    });
  }
  this._ensureImported(session);
  return this._store().markTurnInputTerminal(claim, terminalType, patch);
}

function pendingTurnInputs(sessionId) {
  const session = this._find(sessionId);
  if (!session) return [];
  this._ensureImported(session);
  const ownerScope = resolvedOwnerScope(this, session);
  if (!ownerScope) return [];
  return this._store().pendingTurnInputs(session.id, ownerScope);
}

function outcomeUnknownTurnInputs(sessionId) {
  const session = this._find(sessionId);
  if (!session) return [];
  this._ensureImported(session);
  const ownerScope = resolvedOwnerScope(this, session);
  if (!ownerScope) return [];
  return this._store().outcomeUnknownTurnInputs(session.id, ownerScope);
}

function resolveTurnOwnerScope(sessionId) {
  const session = this._find(sessionId);
  if (!session) {
    return Object.freeze({
      ok: false,
      error: "NO_SESSION",
      ownerScope: null,
    });
  }
  const ownerScope = resolvedOwnerScope(this, session);
  return ownerScope
    ? Object.freeze({ ok: true, error: null, ownerScope })
    : Object.freeze({
        ok: false,
        error: "OWNER_SCOPE_UNAVAILABLE",
        ownerScope: null,
      });
}

function findTurnInputByScheduledRun(sessionId, runId) {
  const session = this._find(sessionId);
  if (!session || !runId) return null;
  this._ensureImported(session);
  return this._store().findTurnInputByAdmissionKey(
    session.id,
    resolvedOwnerScope(this, session),
    "scheduled_task_run_id",
    runId,
  );
}

function findTurnInputByExternalCommand(sessionId, commandId) {
  const session = this._find(sessionId);
  if (!session || !commandId) return null;
  this._ensureImported(session);
  return this._store().findTurnInputByAdmissionKey(
    session.id,
    resolvedOwnerScope(this, session),
    "external_command_id",
    commandId,
  );
}

function findTurnInputByExternalIdentity(sessionId, identity = {}) {
  const session = this._find(sessionId);
  if (session) this._ensureImported(session);
  const ownerScope = resolvedOwnerScope(this, session);
  if (!ownerScope) return null;
  return this._store().findTurnInputByExternalIdentity(ownerScope, identity);
}

function getTurnInputByTurnId(sessionId, turnId) {
  const session = this._find(sessionId);
  if (!session || !turnId) return null;
  this._ensureImported(session);
  const ownerScope = resolvedOwnerScope(this, session);
  if (!ownerScope) return null;
  const admitted = this._store().getTurnInputByTurnId(turnId, ownerScope);
  return admitted?.sessionId === session.id ? admitted : null;
}

module.exports = {
  admitQueuedTurnInput,
  admitTurnInput,
  admitTurnInputFromSource,
  claimTurnInputDispatch,
  findTurnInputByExternalCommand,
  findTurnInputByExternalIdentity,
  findTurnInputByScheduledRun,
  getTurnInputByTurnId,
  markTurnInputPromoted,
  markTurnInputTerminal,
  outcomeUnknownTurnInputs,
  pendingTurnInputs,
  resolveTurnOwnerScope,
};
