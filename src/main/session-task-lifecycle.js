"use strict";

function ownerFor(manager, sessionId) {
  return manager.resolveTurnOwnerScope?.(sessionId)?.ownerScope || null;
}

function identityFor(manager, sessionId, input = {}) {
  const session = manager._find(sessionId);
  const ownerScope = ownerFor(manager, sessionId);
  const turnId = String(input.turnId || "");
  if (!session || !ownerScope || !turnId) return null;
  return {
    sessionId: session.id,
    ownerScope,
    taskId: String(input.taskId || turnId),
    turnId,
  };
}

function ensureTaskLifecycle(sessionId, input = {}) {
  const identity = identityFor(this, sessionId, input);
  if (!identity) return Object.freeze({ ok: false, reason: "OWNER_SCOPE_UNAVAILABLE", lifecycle: null });
  this._ensureImported(this._find(sessionId));
  return this._store().ensureTaskLifecycle({ ...identity, ...input });
}

function transitionTaskLifecycle(sessionId, input = {}) {
  const identity = identityFor(this, sessionId, input);
  if (!identity) return Object.freeze({ ok: false, reason: "OWNER_SCOPE_UNAVAILABLE", lifecycle: null });
  this._ensureImported(this._find(sessionId));
  return this._store().transitionTaskLifecycle({ ...identity, ...input });
}

function markTaskLifecycleDelivered(sessionId, input = {}) {
  const identity = identityFor(this, sessionId, input);
  if (!identity) return Object.freeze({ ok: false, reason: "OWNER_SCOPE_UNAVAILABLE", lifecycle: null });
  this._ensureImported(this._find(sessionId));
  return this._store().markTaskLifecycleDelivered({ ...identity, ...input });
}

function amendTaskLifecycleVerification(sessionId, input = {}) {
  const identity = identityFor(this, sessionId, input);
  if (!identity) return Object.freeze({ ok: false, reason: "OWNER_SCOPE_UNAVAILABLE", lifecycle: null });
  this._ensureImported(this._find(sessionId));
  return this._store().amendTaskLifecycleVerification({ ...input, ...identity });
}

function getTaskLifecycle(sessionId, turnId) {
  const session = this._find(sessionId);
  const ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope || !turnId) return null;
  this._ensureImported(session);
  return this._store().getTaskLifecycle(session.id, ownerScope, String(turnId));
}

function listTaskLifecycles(sessionId, options = {}) {
  const session = this._find(sessionId);
  const ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope) return [];
  this._ensureImported(session);
  return this._store().listTaskLifecycles(session.id, ownerScope, options);
}

/** Unfinished tasks across ALL sessions of the current owner (task center). */
function listUnfinishedTasks(options = {}) {
  let ownerScope = null;
  try { ownerScope = this._resolveCharacterOwnerScope(); } catch { ownerScope = null; }
  if (typeof ownerScope !== "string" || !ownerScope) return [];
  return this._store().listUnfinishedTaskLifecycles(ownerScope, options);
}

function annotateTaskLifecycle(sessionId, input = {}) {
  const session = this._find(sessionId);
  const ownerScope = ownerFor(this, sessionId);
  if (!session || !ownerScope) return Object.freeze({ ok: false, reason: "OWNER_SCOPE_UNAVAILABLE", lifecycle: null });
  return this._store().annotateTaskLifecycle({ sessionId: session.id, ownerScope, turnId: String(input.turnId || ""), metadata: input.metadata });
}

module.exports = {
  amendTaskLifecycleVerification,
  ensureTaskLifecycle,
  getTaskLifecycle,
  listTaskLifecycles,
  listUnfinishedTasks,
  annotateTaskLifecycle,
  markTaskLifecycleDelivered,
  transitionTaskLifecycle,
};
