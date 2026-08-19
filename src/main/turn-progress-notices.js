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

function emitLegalKnowledgeProgress(orchestrator, sessionId, progress = {}) {
  const totalBytes = Number(progress.totalBytes || 0);
  const writtenBytes = Number(progress.writtenBytes || 0);
  const phase = String(progress.phase || "preparing");
  const detail = phase === "downloading"
    ? "正在准备法律知识库"
    : phase === "verifying" ? "正在校验法律知识库"
      : phase === "indexing" ? "正在建立本地检索索引"
        : phase === "installing" ? "正在安装法律知识库" : "正在加载法律知识库";
  orchestrator._emitEngineNotice(sessionId, {
    code: "legalKnowledgePackProgress",
    level: "progress",
    panel: true,
    replace: true,
    replacesCode: "legalKnowledgePackProgress",
    detail,
    progress: { domain: "legal-kb", phase, id: "legal-cn-enterprise", writtenBytes, totalBytes },
  });
}

module.exports = { emitRuntimePackProgress, emitLegalKnowledgeProgress };
