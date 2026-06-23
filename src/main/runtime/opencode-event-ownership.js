"use strict";

/**
 * Classify a raw OpenCode event before a per-session view receives it.
 *
 * OpenCode's global stream contains several scopes:
 * - session events: carry sessionID and belong to exactly one session;
 * - message events: sometimes only carry messageID, so ownership is learned
 *   after a session-owned message/part event;
 * - directory diagnostics: carry no session/message id and must not fail a turn.
 *
 * This module is intentionally pure. ServerManager owns the mutable
 * `ownedMessages` set; this function only decides what the event means.
 */

function extractEventRouting(event) {
  const type = typeof event?.type === "string" ? event.type : "";
  const p = (event && event.properties) || {};
  let sid = p.sessionID || (p.part && p.part.sessionID) || (p.info && p.info.sessionID) || null;
  if (!sid && type.startsWith("session.") && p.info && p.info.id) sid = p.info.id;
  let mid = p.messageID || (p.part && p.part.messageID) || (p.tool && p.tool.messageID) || null;
  if (!mid && type.startsWith("message.") && !type.startsWith("message.part") && p.info && p.info.id) {
    mid = p.info.id;
  }
  return { sid: sid || null, mid: mid || null };
}

function classifyOpencodeEventOwnership({ directory, cwd, event, sessionID, ownedMessages }) {
  const type = String(event?.type || "");
  if (directory && cwd && directory !== cwd) {
    return { action: "drop", scope: "directory", reason: "different_directory", sid: null, mid: null };
  }

  const { sid, mid } = extractEventRouting(event);
  if (sid) {
    if (sessionID && sid !== sessionID) {
      return { action: "drop", scope: "session", reason: "different_session", sid, mid };
    }
    return { action: "deliver", scope: "session", reason: "owned_session", sid, mid, rememberMessage: mid || null };
  }

  if (mid && ownedMessages?.has?.(mid)) {
    return { action: "deliver", scope: "message", reason: "owned_message", sid: null, mid };
  }

  if (mid) {
    return { action: "drop", scope: "message", reason: "unowned_message", sid: null, mid };
  }

  if (type.startsWith("permission.") || type.startsWith("question.")) {
    return { action: "drop", scope: "session", reason: "missing_session_id", sid: null, mid: null };
  }

  if (type === "session.error" || type === "message.error") {
    return { action: "drop", scope: "directory_diagnostic", reason: "unowned_error_diagnostic", sid: null, mid: null };
  }

  return { action: "deliver", scope: "directory", reason: "directory_event", sid: null, mid: null };
}

module.exports = {
  extractEventRouting,
  classifyOpencodeEventOwnership,
};
