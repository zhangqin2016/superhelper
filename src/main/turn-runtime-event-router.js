"use strict";

const { shouldBufferAssistantAnswer } = require("./answer-evidence-finalizer");
const {
  activityFromEngineNotice,
  activityFromProcessPayload,
  appendTimelineNotice,
  appendTimelineText,
  closeStreamingBlocks,
  setActivityLabel,
  upsertTimelineThinking,
  upsertTimelineTool,
} = require("./turn-timeline");
const { getLogger } = require("./logger");
const { applyToolTurnContractRefinement } = require("./model-turn-contract-refinement");
const { buildTaskToolEvidence } = require("./task-run-state");
const { buildToolPreviewLabel } = require("./tool-preview-label.cjs");
const { TERMINAL_TYPES, TURN_OPTIONAL_TYPES } = require("./turn-event-types");

const log = getLogger("turn-runtime-event-router");

function compactToolInput(input, name = "Tool") {
  if (!input || typeof input !== "object") return {};
  return {
    ...input,
    preview: buildToolPreviewLabel({ name, input }),
  };
}

function hasPendingUserBlocks(state = {}) {
  return Boolean(
    state.pendingPermissions?.size ||
    state.pendingQuestions?.size ||
    state.pendingHooks?.size,
  );
}

function resolveToolId(state, payload) {
  if (payload?.id) return payload.id;
  if (payload?.index != null && state.blockIndexToToolId.has(payload.index)) {
    return state.blockIndexToToolId.get(payload.index);
  }
  return null;
}

function resolveToolDoneId(state, payload) {
  const explicit = resolveToolId(state, payload);
  if (explicit) return explicit;
  const running = [...state.tools.values()].filter((tool) => tool?.status === "running");
  return running.length === 1 ? running[0].id : null;
}

function createTurnRuntimeEventRouter(options = {}) {
  const ctx = options.ctx || {};
  const getState = options.getState;
  const emit = options.emit || (() => null);
  const taskRunRuntime = options.taskRunRuntime;
  const subagentRuntime = options.subagentRuntime;
  const claimAgentResumeId = options.claimAgentResumeId || (() => ({ ok: false }));
  const handleRuntimeControl = options.handleRuntimeControl || (() => {});
  const now = options.now || (() => Date.now());

  function stateFor(sessionId) {
    if (typeof getState !== "function") throw new Error("getState adapter is required");
    return getState(sessionId);
  }

  function trackTool(sessionId, id, patch) {
    const state = stateFor(sessionId);
    const toolId = id || `tool_${state.tools.size + 1}`;
    const existing = state.tools.get(toolId) || { id: toolId };
    Object.assign(existing, patch || {});
    state.tools.set(toolId, existing);
    return existing;
  }

  function applyDraft(sessionId, draft = {}) {
    const type = draft.type;
    const payload = draft.payload || {};
    const state = stateFor(sessionId);
    if (!state.turnId && !TURN_OPTIONAL_TYPES.has(type)) {
      log.debug("dropped orphan %s (no active turn)", type);
      return;
    }

    try {
      switch (type) {
        case "turn.accepted":
          state.phase = "streaming";
          emit(sessionId, "turn.accepted", { status: payload.status || "thinking" });
          break;
        case "assistant.delta":
          state.phase = "streaming";
          state.assistantText += String(payload.text || "");
          if (!shouldBufferAssistantAnswer(state.taskContract)) {
            appendTimelineText(state, String(payload.text || ""), now());
            emit(sessionId, "assistant.delta", { text: String(payload.text || "") });
          }
          break;
        case "assistant.supersedes":
          state.supersedes = payload.supersedes || "";
          emit(sessionId, "assistant.supersedes", payload);
          break;
        case "assistant.thinking.delta": {
          const thinkingPiece = String(payload.text || "");
          state.phase = "streaming";
          state.thinkingText += thinkingPiece;
          upsertTimelineThinking(state, thinkingPiece, now());
          emit(sessionId, "assistant.thinking.delta", { text: thinkingPiece });
          break;
        }
        case "content.block": {
          state.phase = "streaming";
          state.contentBlocks.push({
            blockType: payload.blockType || "unknown",
            mediaType: payload.mediaType || "",
            data: payload.data || "",
            ts: now(),
          });
          if (state.contentBlocks.length > 20) state.contentBlocks.splice(0, state.contentBlocks.length - 20);
          emit(sessionId, "content.block", payload);
          break;
        }
        case "stream.metadata":
          emit(sessionId, "stream.metadata", payload);
          break;
        case "protocol.unknown": {
          state.protocolUnknown.push({
            kind: payload.kind || "unknown_runtime_event",
            notice: payload.notice || null,
            event: payload.event || null,
            ts: now(),
          });
          if (state.protocolUnknown.length > 20) {
            state.protocolUnknown.splice(0, state.protocolUnknown.length - 20);
          }
          emit(sessionId, "protocol.unknown", payload);
          break;
        }
        case "tool.started": {
          state.phase = "tool_running";
          const toolId = payload.id || `tool_${state.tools.size + 1}`;
          if (payload.index != null) state.blockIndexToToolId.set(payload.index, toolId);
          const tool = trackTool(sessionId, toolId, {
            name: payload.name,
            input: payload.input || {},
            metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
            title: payload.title || "",
            status: "running",
            parentToolUseId: payload.parentToolUseId || null,
            startedAt: now(),
          });
          taskRunRuntime?.markProgress?.(sessionId, "tool_running", `Running ${tool.name || payload.name || "tool"}`, {
            tool,
            resumeState: {
              lastToolId: toolId,
              lastToolName: tool.name || payload.name || "unknown",
            },
          });
          subagentRuntime?.scheduleWatch?.(sessionId, toolId, tool);
          if (payload.name && payload.input && Object.keys(payload.input).length) {
            require("./usage-reporter").recordToolCall(sessionId, {
              id: toolId,
              name: payload.name,
              input: payload.input,
            });
            require("./diff-capture").captureBeforeSnapshot(sessionId, toolId, payload.name, payload.input);
          }
          upsertTimelineTool(state, {
            id: toolId,
            name: tool.name || payload.name || "unknown",
            input: tool.input || payload.input || {},
            metadata: tool.metadata || payload.metadata || {},
            title: tool.title || payload.title || "",
            status: "running",
            parentToolUseId: payload.parentToolUseId || null,
          }, now());
          const subagent = subagentRuntime?.syncFromTool?.(sessionId, tool);
          if (subagent) emit(sessionId, "subagent.event", { subagent });
          emit(sessionId, "tool.started", {
            id: toolId,
            name: tool.name || payload.name || "unknown",
            input: compactToolInput(tool.input || payload.input || {}, tool.name || payload.name || "unknown"),
            metadata: tool.metadata || payload.metadata || {},
            title: tool.title || payload.title || "",
            parentToolUseId: payload.parentToolUseId || null,
          });
          break;
        }
        case "tool.input.delta": {
          const toolId = resolveToolId(state, payload);
          if (!toolId) break;
          const tool = trackTool(sessionId, toolId, {});
          tool.partialJson = (tool.partialJson || "") + String(payload.partialJson || "");
          upsertTimelineTool(state, tool, now());
          emit(sessionId, "tool.input.delta", { id: toolId, partialJson: String(payload.partialJson || "") });
          break;
        }
        case "tool.input.done": {
          const toolId = resolveToolId(state, payload);
          if (!toolId) break;
          const tool = trackTool(sessionId, toolId, { input: payload.input || {} });
          tool.input = payload.input || tool.input || {};
          upsertTimelineTool(state, tool, now());
          emit(sessionId, "tool.input.done", {
            id: toolId,
            input: compactToolInput(tool.input, tool.name || "unknown"),
          });
          break;
        }
        case "tool.done": {
          const toolId = resolveToolDoneId(state, payload);
          if (!toolId) break;
          const tool = trackTool(sessionId, toolId, {});
          tool.status = payload.status || (payload.isError ? "failed" : "done");
          tool.result = payload.result ?? payload.content ?? null;
          if (payload.metadata && typeof payload.metadata === "object") tool.metadata = payload.metadata;
          if (payload.title) tool.title = payload.title;
          tool.endedAt = now();
          if (Number.isFinite(tool.startedAt)) tool.durationMs = Math.max(0, tool.endedAt - tool.startedAt);
          const evidenceEvent = state.evidenceLedger?.recordTool?.(tool);
          try {
            const taskContract = state.taskContract || state.pendingTaskContract || null;
            const refinement = applyToolTurnContractRefinement({ taskContract, taskRun: state.taskRun, tool, evidenceEvent });
            if (refinement?.externalFactActivated) state.taskContract = taskContract;
          } catch (err) {
            log.warn("runtime task contract refinement failed open: %s", err?.message || err);
          }
          subagentRuntime?.clearWatch?.(sessionId, toolId);
          subagentRuntime?.emitDoneNotice?.(sessionId, tool);
          taskRunRuntime?.addEvidence?.(sessionId, buildTaskToolEvidence(tool), { tool });
          upsertTimelineTool(state, tool, now());
          const subagent = subagentRuntime?.syncFromTool?.(sessionId, tool);
          if (subagent) emit(sessionId, "subagent.event", { subagent });
          emit(sessionId, "tool.done", {
            id: toolId,
            status: tool.status,
            result: tool.result,
            metadata: tool.metadata || {},
            title: tool.title || "",
          });
          require("./diff-capture").emitDiffForTool(sessionId, toolId, ctx, state.turnId);
          break;
        }
        case "subagent.event": {
          const update = subagentRuntime?.applyEvent?.(sessionId, payload);
          if (update) emit(sessionId, "subagent.event", update);
          break;
        }
        case "todo.updated": {
          state.phase = "streaming";
          const toolId = payload.id || `todo_${sessionId}`;
          const todos = Array.isArray(payload.todos) ? payload.todos : [];
          upsertTimelineTool(state, {
            id: toolId,
            name: "todowrite",
            input: { todos },
            status: "done",
            result: null,
            parentToolUseId: null,
          }, now());
          taskRunRuntime?.updatePlanFromTodos?.(sessionId, todos);
          emit(sessionId, "todo.updated", { id: toolId, todos });
          break;
        }
        case "permission.requested":
          state.phase = "awaiting_user";
          state.pendingPermissions.set(payload.requestId, payload);
          taskRunRuntime?.markAwaitingUser?.(sessionId, "permission_requested", "Waiting for permission");
          emit(sessionId, "permission.requested", payload);
          break;
        case "user_question.requested":
          state.phase = "awaiting_user";
          state.pendingQuestions.set(payload.requestId, payload);
          taskRunRuntime?.markAwaitingUser?.(sessionId, "user_question_requested", "Waiting for user answer");
          emit(sessionId, "user_question.requested", payload);
          break;
        case "permission.resolved":
          state.pendingPermissions.delete(payload.requestId);
          state.pendingQuestions.delete(payload.requestId);
          if (state.phase === "awaiting_user" && !hasPendingUserBlocks(state)) state.phase = "streaming";
          emit(sessionId, "permission.resolved", payload);
          break;
        case "user_question.resolved":
          state.pendingQuestions.delete(payload.requestId);
          if (state.phase === "awaiting_user" && !hasPendingUserBlocks(state)) state.phase = "streaming";
          emit(sessionId, "user_question.resolved", payload);
          break;
        case "hook.requested":
          state.phase = "awaiting_user";
          state.pendingHooks.set(payload.requestId, payload);
          taskRunRuntime?.markAwaitingUser?.(sessionId, "hook_requested", "Waiting for hook decision");
          emit(sessionId, "hook.requested", payload);
          break;
        case "hook.resolved":
          state.pendingHooks.delete(payload.requestId);
          if (state.phase === "awaiting_user" && !hasPendingUserBlocks(state)) state.phase = "streaming";
          emit(sessionId, "hook.resolved", payload);
          break;
        case "permission.timeout":
          emit(sessionId, "permission.timeout", payload);
          break;
        case "engine.notice":
        case "engine.warning": {
          const notice = payload.notice || payload;
          const activity = activityFromEngineNotice(notice);
          if (activity) setActivityLabel(state, activity);
          if (activity) taskRunRuntime?.markProgress?.(sessionId, "runtime_progress", activity);
          taskRunRuntime?.updateLivenessFromNotice?.(sessionId, notice, type);
          if (notice) appendTimelineNotice(state, notice, now());
          if (state.turnId) {
            state.notices.push({
              type,
              turnId: state.turnId,
              source: draft.source || "runtime",
              payload,
              ts: now(),
            });
          }
          emit(sessionId, type, payload);
          break;
        }
        case "engine.stderr":
          if (state.turnId) {
            const text = String(payload.text || payload.message || "").trim();
            state.notices.push({
              type: "engine.stderr",
              turnId: state.turnId,
              source: draft.source || "runtime",
              payload: { notice: { code: "stderr", level: "warning", message: text, panel: true, done: false } },
              ts: now(),
            });
          }
          emit(sessionId, "engine.stderr", payload);
          break;
        case "usage.updated": {
          state.usage = payload.usage || payload;
          const stopReason = String(payload.stopReason || "");
          if (stopReason) {
            state.lastStopReason = stopReason;
            if (stopReason !== "unknown") state.sawRecognizedStopReason = true;
          }
          emit(sessionId, "usage.updated", payload);
          break;
        }
        case "assistant.message_stop":
          closeStreamingBlocks(state, now());
          emit(sessionId, "assistant.message_stop", payload);
          break;
        case "process.event": {
          const activity = activityFromProcessPayload(payload);
          if (activity) setActivityLabel(state, activity);
          if (activity) taskRunRuntime?.markProgress?.(sessionId, "runtime_progress", activity);
          state.processEvents.push(payload);
          if (state.processEvents.length > 200) state.processEvents.splice(0, state.processEvents.length - 200);
          emit(sessionId, "process.event", payload);
          break;
        }
        case "session.hydrated":
          if (payload.agentResumeId && !claimAgentResumeId(sessionId, payload.agentResumeId)?.ok) break;
          emit(sessionId, "session.hydrated", payload, { turnId: null });
          break;
        case "resume.updated":
          emit(sessionId, "resume.updated", payload, { turnId: null });
          break;
        case "prompt_suggestions.updated":
          emit(sessionId, "prompt_suggestions.updated", payload, { turnId: null });
          break;
        case "runtime.control":
          handleRuntimeControl(sessionId, payload);
          break;
        default:
          if (TERMINAL_TYPES.has(type)) break;
          emit(sessionId, "engine.warning", {
            notice: {
              code: "unknownRuntimeDraft",
              level: "warning",
              detail: `Unhandled runtime draft ${type}`,
            },
          });
      }
    } catch (err) {
      log.warn("runtime draft handler failed open: %s", err?.message || err);
    }
  }

  return { applyDraft };
}

module.exports = {
  compactToolInput,
  createTurnRuntimeEventRouter,
  hasPendingUserBlocks,
  resolveToolDoneId,
  resolveToolId,
};
