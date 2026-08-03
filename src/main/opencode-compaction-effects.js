"use strict";

const { getLogger } = require("./logger");
const { observePublicHook } = require("./public-hooks");

const log = getLogger("opencode-compaction-effects");

function handleOpencodeCompacted(runner, effect = {}) {
  try {
    require("./session-memory").markSessionCompacted(runner.sessionId, {
      runtime: "opencode",
      mode: "native",
      reason: effect.reason || "runtime_event",
      engineSessionId: effect.sessionID || "",
      summaryMessageId: effect.messageID || "",
    });
  } catch (error) {
    log.warn("session compaction memory update failed: %s", error?.message || String(error));
  }
  observePublicHook(runner.publicHookRuntime, "compaction.after", {
    sessionId: runner.sessionId,
    turnId: runner._activeTaskContract?.turnId || "",
    engineSessionId: effect.sessionID || "",
    summaryMessageId: effect.messageID || "",
    reason: effect.reason || "runtime_event",
  });
}

module.exports = { handleOpencodeCompacted };
