"use strict";

function ownerFor(manager, sessionId) {
  return manager.resolveTurnOwnerScope?.(sessionId)?.ownerScope || null;
}

function persistTaskContextSnapshot(sessionId, input = {}) {
  const session = this._find(sessionId);
  const ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope) return Object.freeze({ ok: false, reason: "OWNER_SCOPE_UNAVAILABLE", context: null });
  this._ensureImported(session);
  return this._store().persistTaskContextSnapshot({
    ...input,
    sessionId: session.id,
    ownerScope,
  });
}

function getTaskContextSnapshot(sessionId, turnId) {
  const session = this._find(sessionId);
  const ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope || !turnId) return null;
  this._ensureImported(session);
  return this._store().getTaskContextSnapshot(session.id, ownerScope, String(turnId));
}

module.exports = { getTaskContextSnapshot, persistTaskContextSnapshot };
