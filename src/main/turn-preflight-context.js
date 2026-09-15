"use strict";

/**
 * Attachment content that send-preflight extracted for this turn (image
 * recognition, document extraction, or the failure notes that replace them).
 *
 * Routing can replace the user's text entirely — character/agent authoring and
 * web-system learning both do. Before 2026-09-15 that override was applied to
 * the RAW text, so everything preflight had extracted from the attached file was
 * dropped without a word: the user attached a document, Lily answered as if
 * nothing were attached. These helpers keep the extraction and the override
 * together.
 */

const { appendExtractedContext } = require("./engine-message-layers");

/** @param {Array<{label: string, content: string}>} contexts */
function applyPreflightContexts(text, contexts = []) {
  return (Array.isArray(contexts) ? contexts : []).reduce(
    (acc, entry) => (entry?.content ? appendExtractedContext(acc, entry.content, entry.label) : acc),
    String(text || ""),
  );
}

function preflightContext(label, content) {
  return content ? { label, content } : null;
}

// Platform records (continuation stopped, agent bound…) are committed with a
// synthetic turn id; a follow-up continues the previous REAL turn.
const SYNTHETIC_TURN_ID = /^turn_(closure_notice|agent_binding|task_pause)_/;

function lastRealTurnId(messages = []) {
  for (let i = (messages?.length || 0) - 1; i >= 0; i -= 1) {
    const turnId = String(messages[i]?.turnId || "");
    if (turnId && !SYNTHETIC_TURN_ID.test(turnId)) return turnId;
  }
  return "";
}

module.exports = { applyPreflightContexts, preflightContext, lastRealTurnId };
