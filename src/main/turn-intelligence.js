"use strict";

const { buildTaskContract } = require("./task-contract");
const { buildTurnPolicy } = require("./turn-policy");
const { getLogger } = require("./logger");

const log = getLogger("turn-intelligence");

function resolveTurnIntelligence({ ctx, session, project = null, text = "", files = [], turnId = "", previousIntentContract = null } = {}) {
  let committedMessages = Array.isArray(session?.messages) ? session.messages : [];
  let sessionSummary = null;
  try {
    committedMessages =
      typeof ctx?.sessionManager?.getConversation === "function"
        ? ctx.sessionManager.getConversation(session.id)
        : committedMessages;
    sessionSummary = require("./session-memory").readSessionSummary(session.id);
  } catch (err) {
    log.warn("intent continuity failed open: %s", err?.message || err);
    committedMessages = [];
    sessionSummary = null;
  }

  try {
    const taskContract = buildTaskContract({
      text,
      files,
      session,
      project,
      messages: committedMessages.filter((message) => message.turnId !== turnId),
      previousIntentContract: previousIntentContract || sessionSummary?.lastIntentContract || null,
    });
    return {
      taskContract,
      turnPolicy: buildTurnPolicy({ text, taskContract }),
      committedMessages,
      sessionSummary,
      continuitySource: committedMessages.length ? "conversation" : sessionSummary?.lastIntentContract ? "summary" : "current_turn",
    };
  } catch (err) {
    log.warn("turn intelligence failed open to baseline: %s", err?.message || err);
    return {
      taskContract: { active: false, kind: "general", taskType: "general", categories: [], intentContract: null },
      turnPolicy: buildTurnPolicy({ text, taskContract: null }),
      committedMessages,
      sessionSummary,
      continuitySource: "baseline",
      error: err?.message || String(err),
    };
  }
}

module.exports = { resolveTurnIntelligence };
