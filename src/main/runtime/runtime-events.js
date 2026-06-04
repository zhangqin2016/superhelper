"use strict";

const RUNTIME_EVENT_TYPES = new Set([
  "turn.accepted",
  "turn.progress",
  "assistant.text",
  "tool.started",
  "tool.input.delta",
  "tool.input.done",
  "tool.done",
  "permission.requested",
  "permission.resolved",
  "user.question.requested",
  "engine.notice",
  "runtime.control",
  "runtime.warning",
  "runtime.error",
  "turn.result",
]);

const WARNING_ACTION_KINDS = new Set([
  "protocol_warning",
  "unknown_runtime_event",
  "unknown_control_request",
]);

function runtimeEvent(type, payload = {}) {
  const safeType = RUNTIME_EVENT_TYPES.has(type) ? type : "runtime.warning";
  return {
    type: safeType,
    source: payload.source || "runtime",
    payload: payload.payload && typeof payload.payload === "object" ? payload.payload : payload,
  };
}

function isWarningAction(action) {
  return WARNING_ACTION_KINDS.has(action?.kind);
}

function runtimeEventFromAction(action) {
  if (!action || typeof action !== "object") return null;

  switch (action.kind) {
    case "stream_message_start":
      return runtimeEvent("turn.accepted", { source: "claude-cli" });
    case "assistant_text":
      return runtimeEvent("assistant.text", { source: "claude-cli", text: action.text || "" });
    case "assistant_tool_use":
    case "stream_tool_start":
      return runtimeEvent("tool.started", {
        source: "claude-cli",
        id: action.id || "",
        name: action.name || "unknown",
        input: action.input || {},
      });
    case "stream_tool_input_delta":
      return runtimeEvent("tool.input.delta", {
        source: "claude-cli",
        index: action.index,
        partialJson: action.partialJson || "",
      });
    case "stream_content_block_stop":
      return runtimeEvent("tool.input.done", { source: "claude-cli", index: action.index });
    case "tool_result":
      return runtimeEvent("tool.done", {
        source: "claude-cli",
        id: action.id || "",
        isError: Boolean(action.isError),
      });
    case "permission_check":
      return runtimeEvent("permission.requested", {
        source: "claude-cli",
        requestId: action.requestId || "",
        toolName: action.toolName || "unknown",
      });
    case "ask_user_question":
      return runtimeEvent("user.question.requested", {
        source: "claude-cli",
        requestId: action.requestId || "",
      });
    case "control_cancel":
      return runtimeEvent("permission.resolved", {
        source: "claude-cli",
        requestId: action.requestId || "",
      });
    case "system_notice":
    case "engine_notice": {
      const notice = action.notice || {};
      const isProgress = notice.code === "taskProgress" || notice.code === "thinkingProgress";
      return runtimeEvent(isProgress ? "turn.progress" : "engine.notice", {
        source: "claude-cli",
        notice,
      });
    }
    case "turn_result":
      return runtimeEvent("turn.result", { source: "claude-cli", event: action.event || null });
    case "runtime_error":
      return runtimeEvent("runtime.error", { source: "claude-cli", event: action.event || null });
    // Interactive hook kinds — block the turn, need user decision
    case "hook_pretool_use_ask":
    case "hook_user_prompt_ask":
      return runtimeEvent("permission.requested", {
        source: "claude-cli",
        requestId: action.requestId || "",
        hookName: action.hookName || "",
        toolName: action.toolName || "",
      });

    // Decision hook kinds — Stop / SubagentStop
    case "hook_stop":
    case "hook_subagent_stop":
      return runtimeEvent("permission.requested", {
        source: "claude-cli",
        requestId: action.requestId || "",
        hookName: action.hookName || "",
      });

    // Informational hook kinds — just emit engine notice
    case "hook_pretool_use":
    case "hook_posttool_use":
    case "hook_posttool_use_failure":
    case "hook_session_start":
    case "hook_precompact":
    case "hook_user_prompt":
    case "hook_notification":
    case "hook_callback":
      return runtimeEvent("engine.notice", {
        source: "claude-cli",
        notice: action.notice || null,
      });

    case "control_response":
    case "initialize_request":
    case "stream_message_delta":
    case "stream_message_stop":
      return runtimeEvent("runtime.control", {
        source: "claude-cli",
        kind: action.kind,
        requestId: action.requestId || "",
        stopReason: action.stopReason || "",
      });
    default:
      if (isWarningAction(action)) {
        return runtimeEvent("runtime.warning", {
          source: "claude-cli",
          kind: action.kind,
          notice: action.notice || null,
        });
      }
      return runtimeEvent("runtime.warning", {
        source: "claude-cli",
        kind: action.kind || "unknown_action",
      });
  }
}

module.exports = {
  RUNTIME_EVENT_TYPES,
  WARNING_ACTION_KINDS,
  runtimeEvent,
  runtimeEventFromAction,
  isWarningAction,
};
