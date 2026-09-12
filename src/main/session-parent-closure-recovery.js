"use strict";

const { reserveTaskContinuation: reserveBudget, cancelTaskContinuations, validateTaskContinuation: validateBudget } = require("./store/task-continuation-budget");

function validateTaskContinuation(sessionId, input = {}) {
  const session = this._find(sessionId), ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope) return { ok: false, reason: "OWNER_SCOPE_UNAVAILABLE" };
  return validateBudget(this._store().db, { sessionId: session.id, ownerScope, continuationTurnId: input.continuationTurnId });
}

function reserveTaskContinuation(sessionId, input = {}) {
  const identity = identityFor(this, sessionId, input);
  if (!identity) return { ok: false, reason: "OWNER_SCOPE_UNAVAILABLE" };
  this._ensureImported(this._find(sessionId));
  return reserveBudget(this._store().db, {
    ...identity, continuationTurnId: input.continuationTurnId,
    progressKeys: input.progressKeys, now: input.now,
  });
}

function ownerFor(manager, sessionId) {
  return manager.resolveTurnOwnerScope?.(sessionId)?.ownerScope || null;
}

function identityFor(manager, sessionId, input = {}) {
  const session = manager._find(sessionId);
  const ownerScope = ownerFor(manager, sessionId);
  const sourceTurnId = String(input.sourceTurnId || "");
  if (!session || !ownerScope || !sourceTurnId) return null;
  return {
    sessionId: session.id,
    ownerScope,
    sourceTurnId,
    recoveryKey: String(input.recoveryKey || ""),
  };
}

function prepareParentClosureRecovery(sessionId, input = {}) {
  const identity = identityFor(this, sessionId, input);
  if (!identity || !identity.recoveryKey) return Object.freeze({ ok: false, reason: "OWNER_SCOPE_UNAVAILABLE", recovery: null });
  this._ensureImported(this._find(sessionId));
  return this._store().prepareParentClosureRecovery({ ...identity, source: input.source, now: input.now });
}

function claimParentClosureRecovery(sessionId, input = {}) {
  const identity = identityFor(this, sessionId, input);
  if (!identity || !identity.recoveryKey) return Object.freeze({ ok: false, reason: "OWNER_SCOPE_UNAVAILABLE", recovery: null });
  this._ensureImported(this._find(sessionId));
  return this._store().claimParentClosureRecovery({ ...identity, now: input.now });
}

function markParentClosureRecoveryDispatched(sessionId, input = {}) {
  const identity = identityFor(this, sessionId, input);
  if (!identity || !identity.recoveryKey) return Object.freeze({ ok: false, reason: "OWNER_SCOPE_UNAVAILABLE", recovery: null });
  this._ensureImported(this._find(sessionId));
  return this._store().markParentClosureRecoveryDispatched({
    ...identity,
    recoveryTurnId: input.recoveryTurnId,
    claimToken: input.claimToken,
    now: input.now,
  });
}

function markParentClosureRecoveryUnavailable(sessionId, input = {}) {
  const identity = identityFor(this, sessionId, input);
  if (!identity || !identity.recoveryKey) return Object.freeze({ ok: false, reason: "OWNER_SCOPE_UNAVAILABLE", recovery: null });
  this._ensureImported(this._find(sessionId));
  return this._store().markParentClosureRecoveryUnavailable({
    ...identity,
    claimToken: input.claimToken,
    reason: input.reason,
    now: input.now,
  });
}

function getParentClosureRecovery(sessionId, sourceTurnId) {
  const session = this._find(sessionId);
  const ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope || !sourceTurnId) return null;
  this._ensureImported(session);
  return this._store().getParentClosureRecovery(session.id, String(sourceTurnId), ownerScope);
}

function listFutureParentClosureRecoveries(sessionId, now = Date.now()) {
  const session = this._find(sessionId);
  const ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope) return [];
  return this._store().listFutureParentClosureRecoveries(session.id, ownerScope, now);
}

function cancelPendingParentClosureRecoveries(sessionId, options = {}) {
  const session = this._find(sessionId);
  const ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope) return;
  cancelTaskContinuations(this._store().db, { sessionId: session.id, ownerScope, preservedTurnId: options.preservedTurnId });
  this._store().cancelPendingParentClosureRecoveries(session.id, ownerScope);
}

function listPendingParentClosureRecoveries(sessionId, now = Date.now()) {
  const session = this._find(sessionId);
  const ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope) return [];
  this._ensureImported(session);
  return this._store().listPendingParentClosureRecoveries(session.id, ownerScope, now);
}

module.exports = {
  validateTaskContinuation,
  reserveTaskContinuation,
  cancelPendingParentClosureRecoveries,
  claimParentClosureRecovery,
  getParentClosureRecovery,
  listPendingParentClosureRecoveries,
  listFutureParentClosureRecoveries,
  markParentClosureRecoveryDispatched,
  markParentClosureRecoveryUnavailable,
  prepareParentClosureRecovery,
};
