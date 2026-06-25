"use strict";

const crypto = require("node:crypto");
const { buildTurnArtifacts } = require("./turn-artifacts");
const { ARTIFACT_SCHEMA_VERSION } = require("./session-artifact-backfill");
const { buildTurnResultBlocks, RESULT_BLOCK_SCHEMA_VERSION } = require("./turn-result-blocks");
const { estimateTokensForText } = require("./context-budget-manager");

class TurnArchive {
  constructor(sessionManager, options = {}) {
    this.sessionManager = sessionManager;
    this.eventBus = options.eventBus || null;
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
      startedAt: Number.isFinite(tool.startedAt) ? tool.startedAt : null,
      endedAt: Number.isFinite(tool.endedAt) ? tool.endedAt : null,
      durationMs: Number.isFinite(tool.durationMs) ? tool.durationMs : null,
    }));
    const workspacePath = this._resolveWorkspacePath(state.sessionId);
    const artifacts = buildTurnArtifacts({
      assistantText,
      fileChanges,
      tools,
      workspacePath,
    });
    const contentBlocks = (state.contentBlocks || []).slice(-20);
    // Typed blocks a tool/skill declared in its result — rendered directly, no
    // path-scraping (the protocol's "tools emit blocks" path toward zero
    // derivation). A tool opts in by returning result.blocks / result.resultBlocks.
    const extraBlocks = [];
    for (const tool of tools) {
      const r = tool.result;
      if (!r || typeof r !== "object") continue;
      const declared = Array.isArray(r.blocks)
        ? r.blocks
        : Array.isArray(r.resultBlocks)
          ? r.resultBlocks
          : null;
      if (declared) {
        for (const block of declared) {
          if (block && block.type) extraBlocks.push(block);
        }
      }
    }
    const resultBlocks = buildTurnResultBlocks({
      artifacts,
      contentBlocks,
      extraBlocks,
    });
    const userPayload = state.currentPayload || null;
    const rawUserText = userPayload
      ? String(userPayload.rawText || userPayload.displayText || userPayload.text || "")
      : "";
    const enginePayload = state.enginePayload || null;
    const engineText = String(enginePayload?.text || "");
    const usageInputTokens = Number(
      state.usage?.input_tokens ??
        state.usage?.inputTokens ??
        state.usage?.prompt_tokens ??
        0,
    );
    const promptTokenEstimate = Number.isFinite(usageInputTokens) && usageInputTokens > 0
      ? {
          tokens: usageInputTokens,
          source: "runtime_usage",
          provider: enginePayload?.provider || enginePayload?.trace?.provider || "",
          model: enginePayload?.model || enginePayload?.trace?.model || "",
        }
      : estimateTokensForText(engineText, {
      provider: enginePayload?.provider || enginePayload?.trace?.provider || "",
      model: enginePayload?.model || enginePayload?.trace?.model || "",
    });
    const effectiveTextPreview =
      engineText && engineText !== rawUserText
        ? engineText.slice(0, 1200)
        : null;
    const failureMeta = terminalType === "turn.failed"
      ? {
          error: typeof payload.error === "string" ? payload.error : "",
          errorCode: payload.errorCode || payload.code || "",
          errorCategory: payload.errorCategory || payload.category || "",
          retryable: payload.retryable !== false,
          source: payload.source || "",
          exitCode: payload.exitCode ?? null,
        }
      : null;

    const record = {
      turnId: state.turnId,
      sessionId: state.sessionId,
      startedAt: state.startedAt || Date.now(),
      endedAt: Date.now(),
      terminal: terminalType,
      user: userPayload
        ? {
            text: rawUserText,
            files: userPayload.displayFiles || null,
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
      // Engine message id for session:rewind (revert the engine to this turn).
      engineMessageId: payload.engineMessageId ?? null,
      processEvents: (state.processEvents || []).slice(-100),
      notices: (state.notices || []).slice(-20),
      usage: state.usage || null,
      meta: {
        terminal: terminalType,
        interrupted: terminalType === "turn.interrupted",
        stalled: terminalType === "turn.stalled",
        failed: terminalType === "turn.failed",
        failure: failureMeta,
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
        turnPolicy: state.turnPolicy
          ? {
              schemaVersion: state.turnPolicy.schemaVersion || 1,
              taskType: state.turnPolicy.taskType || "",
              rigor: state.turnPolicy.rigor || "fast",
              requiresFreshness: Boolean(state.turnPolicy.requiresFreshness),
              requiresWorkspaceGrounding: Boolean(state.turnPolicy.requiresWorkspaceGrounding),
              requiresSourceCoverage: Boolean(state.turnPolicy.requiresSourceCoverage),
              allowedClaimStrength: state.turnPolicy.allowedClaimStrength || "casual",
            }
          : null,
        evidenceSummary: state.evidenceLedger?.summary?.() || null,
        engine: enginePayload
          ? {
              textChanged: Boolean(engineText && engineText !== rawUserText),
              effectiveTextPreview,
              promptChars: engineText.length,
              estimatedPromptTokens: promptTokenEstimate.tokens,
              estimatedPromptTokenSource: promptTokenEstimate.source,
              trace: enginePayload.trace || null,
            }
          : null,
      },
    };
    try {
      const session = typeof this.sessionManager?.findById === "function"
        ? this.sessionManager.findById(state.sessionId)
        : null;
      record.meta.skillUsageAudit = require("./skill-usage-audit").buildSkillUsageAudit({
        userText: rawUserText,
        session,
        tools,
      });
    } catch {
      record.meta.skillUsageAudit = null;
    }
    try {
      record.meta.subagentTelemetry = require("./subagent-telemetry").buildSubagentTelemetry(record);
    } catch {
      record.meta.subagentTelemetry = null;
    }
    try {
      record.meta.evidenceGraph = require("./evidence-graph").buildEvidenceGraph(record);
    } catch {
      record.meta.evidenceGraph = null;
    }
    try {
      record.meta.evidenceReplayBundle = require("./evidence-replay-bundle").buildEvidenceReplayBundle(record);
    } catch {
      record.meta.evidenceReplayBundle = null;
    }
    try {
      record.meta.contextOsScorecard = require("./context-os-scorecard").evaluateContextOsScorecard(record);
    } catch {
      record.meta.contextOsScorecard = null;
    }
    return record;
  }

  commit(sessionId, record) {
    if (!record) return null;
    const failed = record.terminal === "turn.failed";
    const isOpencodeBacked = Boolean(record.engineMessageId);
    const extra = {
      id: `msg_${crypto.randomUUID()}`,
      turnId: record.turnId,
      record: isOpencodeBacked
        ? {
            ...record,
            meta: {
              ...(record.meta || {}),
              canonicalSource: "opencode",
              lilyStorageRole: "metadata",
            },
          }
        : record,
      ...(failed ? { failed: true } : {}),
      meta: {
        ...(record.meta || {}),
        ...(isOpencodeBacked
          ? {
              canonicalSource: "opencode",
              lilyStorageRole: "metadata",
            }
          : {}),
      },
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
    try {
      const session = this.sessionManager?.findById?.(sessionId);
      if (session?.projectId) {
        const promoted = require("./auto-memory-proposals").promoteMemoryProposalsFromRecord(session.projectId, record);
        if (promoted?.status === "proposed" && promoted.proposal) {
          this.eventBus?.emit?.(sessionId, {
            type: "memory.proposal",
            turnId: record.turnId || null,
            source: "turn_archive",
            payload: {
              projectId: session.projectId,
              proposal: promoted.proposal,
            },
          });
        }
      }
    } catch (err) {
      console.warn("[auto-memory] proposal failed:", err?.message || err);
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
