"use strict";

const { getLogger } = require("./logger");
const { appendTimelineNotice } = require("./turn-timeline");
const log = getLogger("turn-terminal-finalizer");

// Collect learned drafts after a completed turn without making terminal
// delivery depend on optional skill discovery or guide refresh.
function collectLearnedSkills(ctx, sessionId, state) {
  try {
    const { collectLearnedSkillDrafts } = require("./learned-skills");
    const skillManager = require("./skill-manager");
    const session = ctx.sessionManager?.findById?.(sessionId) || null;
    const project = session?.projectId && ctx.projectManager?.find
      ? ctx.projectManager.find(session.projectId)
      : null;
    const learned = collectLearnedSkillDrafts(
      skillManager.registerLearnedSkillDir,
      undefined,
      {
        sessionId,
        projectId: session?.projectId || "",
        workspacePath: project?.path || "",
      },
    );
    if (!learned.length) return;
    if (session) {
      try {
        skillManager.writeSessionAgentGuide(sessionId, session, project?.path || "");
      } catch (err) {
        log.warn("learned skill guide refresh failed: %s", err?.message || err);
      }
    }
    appendTimelineNotice(state, {
      code: "learnedSkillDraft",
      level: "info",
      panel: true,
      done: true,
    }, Date.now());
  } catch (err) {
    log.warn("learned skill collection failed: %s", err?.message || err);
  }
}

module.exports = { collectLearnedSkills };
