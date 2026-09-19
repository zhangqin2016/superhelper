"use strict";

const { buildTaskContract } = require("./task-contract");
const { buildTurnPolicy } = require("./turn-policy");
const { getLogger } = require("./logger");

const log = getLogger("turn-intelligence");

// Sixty turns of history is more than any intent-continuity rule looks back;
// reading further only costs (0.6 s per call on a 1,400-message session).
const RECENT_CONTEXT_MESSAGES = 120;

function resolveTurnIntelligence({ ctx, session, project = null, text = "", files = [], turnId = "", previousIntentContract = null, missingRecoverySource = false } = {}) {
  let committedMessages = Array.isArray(session?.messages) ? session.messages : [];
  let sessionSummary = null;
  try {
    // A tail is all intent continuity ever reads; the whole session is not.
    committedMessages =
      typeof ctx?.sessionManager?.getRecentConversation === "function"
        ? ctx.sessionManager.getRecentConversation(session.id, { limit: RECENT_CONTEXT_MESSAGES })
        : typeof ctx?.sessionManager?.getConversation === "function"
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
      // An explicitly supplied, host-validated recovery source outranks the
      // latest visible task. Native history remains intact in committedMessages.
      messages: previousIntentContract || missingRecoverySource ? [] : committedMessages.filter((message) => message.turnId !== turnId),
      previousIntentContract: missingRecoverySource ? null : previousIntentContract || sessionSummary?.lastIntentContract || null,
    });
    let taskRequest = { text, complete: false, reason: "recovery_source_unavailable" };
    if (!missingRecoverySource) {
      try {
        taskRequest = require("./task-request-source").bindTaskRequest({ manager: ctx?.sessionManager, session, taskContract, turnId, text });
      } catch (err) {
        log.warn("request lineage unavailable; preserving native task contract: %s", err?.message || err);
        taskRequest = { text, complete: false, reason: "request_source_unavailable" };
      }
    }
    return {
      taskContract,
      taskRequest,
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
