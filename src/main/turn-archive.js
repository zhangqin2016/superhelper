"use strict";

const crypto = require("node:crypto");

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
      contentBlocks: (state.contentBlocks || []).slice(-20),
      protocolUnknown: (state.protocolUnknown || []).slice(-20),
      tools,
      fileChanges,
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
}

module.exports = { TurnArchive };
