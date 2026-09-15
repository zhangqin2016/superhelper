"use strict";

/**
 * Turn-start refresh of the compaction handoff file the two compaction plugins
 * read (compaction-memory.js: navigation blocks; compaction-continuity.js:
 * task anchor + per-turn guidance). Keyed by the ENGINE session id. Fail-safe:
 * any error leaves the file as it was and the engine compacts as before.
 */

const MAX_GUIDANCE_CHARS = 60_000;

function refreshCompactionMemoryForSession({ sessionId, engineSessionId, anchor = null, guidance = "" } = {}) {
  if (!engineSessionId) return "";
  const { userDataPath } = require("./config");
  const { COMPACTION_MEMORY_DIRNAME, writeCompactionMemoryFile } = require("./compaction-memory-export");
  const summary = sessionId ? require("./session-memory").readSessionSummary(sessionId) : null;
  return writeCompactionMemoryFile(userDataPath(COMPACTION_MEMORY_DIRNAME), engineSessionId, summary, {
    anchor: anchor && typeof anchor === "object" ? anchor : null,
    guidance: String(guidance || "").slice(0, MAX_GUIDANCE_CHARS),
  });
}

module.exports = { refreshCompactionMemoryForSession, MAX_GUIDANCE_CHARS };
