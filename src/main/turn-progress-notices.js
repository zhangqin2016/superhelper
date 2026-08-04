"use strict";

function emitRuntimePackProgress(orchestrator, sessionId, progress = {}) {
  const totalBytes = Number(progress.totalBytes || 0);
  const writtenBytes = Number(progress.writtenBytes || 0);
  const detail = String(progress.detail || progress.phase || "Preparing task capability").trim();
  orchestrator._emitEngineNotice(sessionId, {
    code: "workProgress",
    level: "progress",
    panel: true,
    replace: true,
    replacesCode: "runtimePackPreparing",
    detail,
    progress: {
      domain: "runtime-pack",
      phase: String(progress.phase || "preparing"),
      id: String(progress.id || ""),
      writtenBytes,
      totalBytes,
    },
  });
}

module.exports = { emitRuntimePackProgress };
