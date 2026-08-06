"use strict";

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

function listPendingParentClosureRecoveries(sessionId) {
  const session = this._find(sessionId);
  const ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope) return [];
  this._ensureImported(session);
  return this._store().listPendingParentClosureRecoveries(session.id, ownerScope);
}

module.exports = {
  claimParentClosureRecovery,
  getParentClosureRecovery,
  listPendingParentClosureRecoveries,
  markParentClosureRecoveryDispatched,
  markParentClosureRecoveryUnavailable,
  prepareParentClosureRecovery,
};
