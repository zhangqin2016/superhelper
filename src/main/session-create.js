"use strict";

/**
 * Creating a conversation — the one place, whoever asks.
 *
 * The desktop's "new conversation" and a paired phone's both land here, so a
 * session made from the phone is the same kind of session: the public
 * session.start hook fires, and a distributed default 智能体 binds to it.
 * `activate: false` (the phone) leaves the desktop's active conversation
 * alone — the phone drives its own target, the desktop's screen is not
 * switched under its user.
 */
async function createSessionFor(ctx, projectId, title, { source = "desktop", activate = true } = {}) {
  const pid = projectId || ctx.projectManager?.getActive?.()?.id;
  if (!pid) return { ok: false, error: "NO_PROJECT" };
  const session = ctx.sessionManager.create(pid, title, { activate });
  require("./public-hooks").observePublicHook(ctx.publicHookRuntime, "session.start", {
    sessionId: session.id,
    projectId: pid,
    source,
  });
  // A distributed default 智能体 (enterprise/admin targeting) binds to new
  // conversations at creation. Fail-open: no default → native session.
  let agent = null;
  try {
    const applied = await require("./agents/agent-distribution").applyDefaultAgentToNewSession(ctx, session.id);
    if (applied?.applied) agent = { id: applied.agentId };
  } catch { /* native */ }
  return { ok: true, session: { id: session.id, title: session.title, projectId: pid, ...(agent ? { agent } : {}) } };
}

module.exports = { createSessionFor };
