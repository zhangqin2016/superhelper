"use strict";

/**
 * Keep the engine session (and its conversation context) when the session's
 * skill set changes on purpose.
 *
 * The resume binding pins `enabledSkillIdsHash`; a mismatch at spawn used to
 * mean "start the engine session fresh" — right for a stale binding, wrong for
 * a change the user just made (toggling skills, activating an agent), where it
 * silently dropped the whole engine history. The per-session AGENT.md is
 * rewritten before the next spawn, so re-pinning the hash to the NEW skill set
 * is safe: the resumed engine reads the current guide and tool scope.
 * Kill switch LILY_KEEP_ENGINE_ON_SKILL_CHANGE=0 restores the old reset.
 */

function keepEngineAcrossSkillChange(ctx, sessionId) {
  try {
    if (process.env.LILY_KEEP_ENGINE_ON_SKILL_CHANGE === "0") return { ok: true, kept: false, reason: "disabled" };
    const manager = ctx?.sessionManager;
    const session = manager?.findById?.(sessionId);
    if (!session?.agentResumeId || !session.agentResumeBinding || typeof session.agentResumeBinding !== "object") {
      return { ok: true, kept: false, reason: "no_resume_binding" };
    }
    const { skillSetHash } = require("./resume-binding");
    const activeSkillIds = require("./skill-manager").resolveSessionSkillIds(session);
    const nextHash = skillSetHash(activeSkillIds);
    if (session.agentResumeBinding.enabledSkillIdsHash === nextHash) return { ok: true, kept: true, reason: "unchanged" };
    if (typeof manager.claimAgentResumeId !== "function") return { ok: true, kept: false, reason: "manager_unavailable" };
    const claimed = manager.claimAgentResumeId(sessionId, session.agentResumeId, { ...session.agentResumeBinding, enabledSkillIdsHash: nextHash });
    return { ok: Boolean(claimed?.ok), kept: Boolean(claimed?.ok), reason: claimed?.ok ? "rebound" : "claim_failed" };
  } catch (error) {
    return { ok: false, kept: false, reason: error?.message || "error" };
  }
}

module.exports = { keepEngineAcrossSkillChange };
