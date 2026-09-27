"use strict";

// One classifier for tool completion, shared by the main turn and the subagent
// projection. A tool failure the work RECOVERED from — a LATER call of the SAME
// tool reached a done status — is not a failure. The main turn adopted this on
// 2026-09-02 (fccfb9f3) so a 278-tool turn no longer read as broken over a
// single mid-turn guard rejection 28 minutes before the end. The subagent
// projection classified failure naively (any failed tool → the whole subagent
// "failed"), so a no-match `grep` (exit 1) or a first-try command the subagent
// then recovered from marked the whole subtask failed. Routing both paths
// through this ONE organ keeps them honest and consistent.

function isFailedToolStatus(status) {
  return ["failed", "error", "cancelled", "canceled", "timeout"].includes(String(status || "").toLowerCase());
}

function isDoneToolStatus(status) {
  return ["done", "completed", "success"].includes(String(status || "").toLowerCase());
}

/**
 * Partition ORDERED tools into done / failed / running / recovered. A failed
 * tool moves to `recovered` when a later tool of the same name reached a done
 * status. Returns the original tool objects so each caller maps to its own shape.
 */
function partitionToolCompletion(tools = []) {
  const list = Array.from(tools || []);
  const lastDoneIndex = new Map();
  list.forEach((tool, index) => {
    if (isDoneToolStatus(tool?.status)) lastDoneIndex.set(String(tool?.name || ""), index);
  });
  const done = [];
  const failed = [];
  const running = [];
  const recovered = [];
  list.forEach((tool, index) => {
    if (isDoneToolStatus(tool?.status)) done.push(tool);
    else if (isFailedToolStatus(tool?.status)) {
      const recoveredAt = lastDoneIndex.get(String(tool?.name || ""));
      if (Number.isInteger(recoveredAt) && recoveredAt > index) recovered.push(tool);
      else failed.push(tool);
    } else running.push(tool);
  });
  return { done, failed, running, recovered };
}

module.exports = { isFailedToolStatus, isDoneToolStatus, partitionToolCompletion };
