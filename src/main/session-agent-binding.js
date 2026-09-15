"use strict";

/**
 * 智能体 binding mirror on the session record.
 *
 * The TRUTH lives in messages.db (`agent_session_bindings`, see
 * agents/agent-repository.js). sessions.json only carries a bounded display
 * mirror so the sidebar/session list can show "which agent" without a
 * database read. The mirror never gates behaviour: session-agent-policy.js
 * reads the repository.
 */

function setSessionAgentBinding(manager, sessionId, mirror) {
  const session = manager._find(sessionId);
  if (!session) return false;
  if (!mirror || typeof mirror !== "object" || !mirror.agentId) {
    delete session.agentBinding;
  } else {
    session.agentBinding = {
      agentId: String(mirror.agentId),
      agentRevisionId: String(mirror.agentRevisionId || ""),
      name: String(mirror.name || "").slice(0, 120),
      icon: String(mirror.icon || "").slice(0, 16),
      bindingVersion: Number(mirror.bindingVersion) || 0,
    };
  }
  session.updatedAt = new Date().toISOString();
  manager.save();
  return true;
}

/** `{ agent: {id, name, icon} }` for session list items, or `{}`. */
function sessionAgentProjection(session) {
  const mirror = session?.agentBinding;
  if (!mirror || typeof mirror !== "object" || !mirror.agentId) return {};
  return { agent: { id: mirror.agentId, name: String(mirror.name || ""), icon: String(mirror.icon || "") } };
}

module.exports = { setSessionAgentBinding, sessionAgentProjection };
