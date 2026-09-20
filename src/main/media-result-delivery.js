"use strict";

const crypto = require("node:crypto");
const { engineNotice } = require("../shared/engine-notices.mjs");

// Media completion is a persisted platform message, not a new user task.
function deliverMediaResult(ctx, sessionId, record, paths) {
  const manager = ctx.sessionManager;
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify([sessionId, record.type, [...paths].sort()])).digest("hex");
  const id = `msg_media_${digest}`;
  let message = manager.findMessage(sessionId, id);
  if (!message) {
    manager.pushMessageTo(sessionId, "assistant", record.content, null, {
      id,
      meta: { mediaResult: { type: record.type, paths, sourceTurnId: record.turnId || null } },
    });
    message = manager.findMessage(sessionId, id);
    if (!message) return false;
  }
  ctx.eventBus.emit(sessionId, {
    type: "engine.notice", turnId: null, source: "media_result",
    payload: { notice: engineNotice("mediaResultDelivered"), committedMessage: message },
  });
  return true;
}

function containsMediaPaths(value, paths) {
  if (typeof value === "string") {
    const normalized = value.replace(/\\/g, "/");
    return paths.every((p) => {
      const needle = String(p).replace(/\\/g, "/");
      if (!needle) return false;
      const windows = /^[a-z]:\//i.test(needle);
      const haystack = windows ? normalized.toLowerCase() : normalized;
      const target = windows ? needle.toLowerCase() : needle;
      let at = haystack.indexOf(target);
      while (at >= 0) {
        const after = haystack[at + target.length];
        if (!after || /[\s"'<>\]\)},;，。；]/u.test(after)) return true;
        at = haystack.indexOf(target, at + 1);
      }
      return false;
    });
  }
  if (!value || typeof value !== "object") return false;
  // Visit leaves rather than JSON encoding: encoding doubles Windows separators.
  const strings = [];
  const visit = (v) => {
    if (typeof v === "string") strings.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  return paths.every((p) => strings.some((v) => containsMediaPaths(v, [p])));
}

module.exports = { deliverMediaResult, containsMediaPaths };
