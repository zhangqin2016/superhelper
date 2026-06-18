"use strict";

const crypto = require("node:crypto");
const { buildTurnArtifacts } = require("./turn-artifacts");
const { ARTIFACT_SCHEMA_VERSION } = require("./session-artifact-backfill");
const { buildTurnResultBlocks, RESULT_BLOCK_SCHEMA_VERSION } = require("./turn-result-blocks");

class TurnArchive {
  constructor(sessionManager) {
    this.sessionManager = sessionManager;
  }

  buildRecord(state, terminalType, payload = {}) {
    const { getDiffsForTurn } = require("./diff-capture");
    const assistantText = String(payload.assistant ?? state.assistantText ?? "").trim();
    const fileChanges = getDiffsForTurn(state.sessionId, state.turnId).map((entry) => ({
      turnId: entry.turnId,
      toolId: entry.toolId || null,
      filePath: entry.filePath,
      fileName: entry.fileName,
      status: entry.status,
      diff: entry.diff,
      originalContent: entry.originalContent,
      stats: entry.stats || null,
    }));
    const tools = [...(state.tools?.values() || [])].map((tool) => ({
      id: tool.id,
      name: tool.name || "unknown",
      input: tool.input || {},
      partialJson: tool.partialJson || undefined,
      result: tool.result || null,
      status: tool.status || "done",
      parentToolUseId: tool.parentToolUseId || null,
    }));
    const workspacePath = this._resolveWorkspacePath(state.sessionId);
    const artifacts = buildTurnArtifacts({
      assistantText,
      fileChanges,
      tools,
      workspacePath,
    });
    const contentBlocks = (state.contentBlocks || []).slice(-20);
    const resultBlocks = buildTurnResultBlocks({
      artifacts,
      contentBlocks,
    });

    return {
      turnId: state.turnId,
      sessionId: state.sessionId,
      startedAt: state.startedAt || Date.now(),
      endedAt: Date.now(),
      terminal: terminalType,
      user: state.currentPayload
        ? {
            text: state.currentPayload.text || "",
            files: state.currentPayload.displayFiles || null,
          }
        : null,
      assistantText,
      thinkingText: state.thinkingText || "",
      contentBlocks,
      protocolUnknown: (state.protocolUnknown || []).slice(-20),
      tools,
      fileChanges,
      artifacts,
      artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
      resultBlocks,
      resultBlockSchemaVersion: RESULT_BLOCK_SCHEMA_VERSION,
      timeline: (state.timeline || []).slice(-100),
      activityLabel: state.activityLabel || null,
      durationMs: payload.durationMs ?? state.durationMs ?? null,
      totalCostUsd: payload.totalCostUsd ?? state.totalCostUsd ?? null,
      processEvents: (state.processEvents || []).slice(-100),
      notices: (state.notices || []).slice(-20),
      usage: state.usage || null,
      meta: {
        terminal: terminalType,
        interrupted: terminalType === "turn.interrupted",
        stalled: terminalType === "turn.stalled",
        failed: terminalType === "turn.failed",
        resultFromCli: Boolean(payload.resultFromCli),
        toolsSummary: { count: tools.length },
        taskContract: state.taskContract
          ? {
              kind: state.taskContract.kind,
              taskType: state.taskContract.taskType || "",
              categories: state.taskContract.categories || [],
              workspaceProfile: state.taskContract.workspaceProfile || "",
              workspaceSignals: state.taskContract.workspaceSignals || [],
              verificationStrategy: state.taskContract.verificationStrategy || [],
            }
          : null,
      },
    };
  }

  commit(sessionId, record) {
    if (!record) return null;
    const failed = record.terminal === "turn.failed";
    const extra = {
      id: `msg_${crypto.randomUUID()}`,
      turnId: record.turnId,
      record,
      ...(failed ? { failed: true } : {}),
      meta: record.meta || undefined,
    };
    this.sessionManager.pushMessageTo(
      sessionId,
      "assistant",
      record.assistantText || "",
      null,
      extra,
    );
    try {
      require("./session-memory").updateSessionSummaryFromRecord(sessionId, record);
    } catch (err) {
      console.warn("[session-memory] update failed:", err?.message || err);
    }
    return extra;
  }

  _resolveWorkspacePath(sessionId) {
    try {
      const session = this.sessionManager?.findById?.(sessionId);
      const project = session?.projectId
        ? this.sessionManager?.pm?.find?.(session.projectId)
        : null;
      return project?.path || session?.workspacePath || "";
    } catch {
      return "";
    }
  }
}

module.exports = { TurnArchive };
