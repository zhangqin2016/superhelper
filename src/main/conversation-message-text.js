"use strict";

/**
 * The visible text of a conversation message — one rule for every reader.
 *
 * A rich assistant turn can carry an empty top-level `content` while its answer
 * lives in `record.assistantText`. Readers that looked only at `content` lost
 * those answers: the desktop failed to dedup such a turn against the official
 * OpenCode copy (it showed twice on reopen), and the phone dropped it.
 */
function messageText(message = {}) {
  return String(message?.content || message?.text || message?.record?.assistantText || "");
}

module.exports = { messageText };
