"use strict";

function ownerFor(manager, sessionId) {
  return manager.resolveTurnOwnerScope?.(sessionId)?.ownerScope || null;
}

function persistTaskResult(sessionId, result = {}) {
  const session = this._find(sessionId);
  const ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope) return Object.freeze({ ok: false, reason: "OWNER_SCOPE_UNAVAILABLE", result: null });
  return this._store().persistTaskResult({ ...result, sessionId: session.id, ownerScope });
}

function markTaskResultDelivered(sessionId, turnId, delivery = {}) {
  const session = this._find(sessionId);
  const ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope) return Object.freeze({ ok: false, reason: "OWNER_SCOPE_UNAVAILABLE", result: null });
  return this._store().markTaskResultDelivered({ sessionId: session.id, ownerScope, turnId, delivery });
}

function getTaskResult(sessionId, turnId) {
  const session = this._find(sessionId);
  const ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope) return null;
  return this._store().getTaskResult(session.id, ownerScope, turnId);
}

module.exports = { getTaskResult, markTaskResultDelivered, persistTaskResult };
