"use strict";

const { normalizeClaudeEvent } = require("./claude-event-normalizer");
const { backgroundActivityFromEvent } = require("./runtime/runtime-activity");

const WARNING_ACTION_KINDS = new Set([
  "protocol_warning",
  "unknown_runtime_event",
  "unknown_control_request",
]);

function isWarningAction(action) {
  return WARNING_ACTION_KINDS.has(action?.kind);
}

function runtimeDraft(type, payload = {}) {
  return {
    type,
    source: payload.source || "claude-cli",
    payload,
  };
}

function runtimeEventFromAction(action) {
  if (!action || typeof action !== "object") return null;

  switch (action.kind) {
    case "stream_message_start":
      return runtimeDraft("turn.accepted", {});
    case "assistant_text":
      return runtimeDraft("assistant.delta", { text: action.text || "" });
    case "assistant_thinking":
      return runtimeDraft("assistant.thinking.delta", { text: action.text || "" });
    case "assistant_tool_use":
    case "stream_tool_start":
      return runtimeDraft("tool.started", {
        id: action.id || "",
        name: action.name || "unknown",
        input: action.input || {},
        index: action.index,
        parentToolUseId: action.parentToolUseId || null,
      });
    case "stream_tool_input_delta":
      return runtimeDraft("tool.input.delta", {
        index: action.index,
        partialJson: action.partialJson || "",
      });
    case "stream_content_block_stop":
      return runtimeDraft("tool.input.done", { index: action.index });
    case "tool_result":
      return runtimeDraft("tool.done", {
        id: action.id || "",
        isError: Boolean(action.isError),
        content: action.content || null,
      });
    case "permission_check":
      return runtimeDraft("permission.requested", {
        requestId: action.requestId || "",
        toolName: action.toolName || "unknown",
        input: action.input || {},
        title: action.title || "",
        description: action.description || "",
        suggestions: action.suggestions || [],
      });
    case "ask_user_question":
      return runtimeDraft("user_question.requested", {
        requestId: action.requestId || "",
        input: action.input || {},
        questions: action.questions || [],
      });
    case "control_cancel":
      return runtimeDraft("permission.resolved", {
        requestId: action.requestId || "",
        cancelled: true,
      });
    case "system_notice":
    case "engine_notice": {
      const notice = action.notice || {};
      if (action.subtype === "init") {
        return runtimeDraft("session.hydrated", {
          agentResumeId: action.sessionId || "",
          notice,
        });
      }
      if (action.subtype === "thinking_tokens") {
        return runtimeDraft("usage.updated", {
          estimatedTokens: action.estimated_tokens,
          estimatedTokensDelta: action.estimated_tokens_delta,
          notice,
        });
      }
      return runtimeDraft(notice.level === "warning" ? "engine.warning" : "engine.notice", {
        notice,
      });
    }
    case "turn_result":
      return runtimeDraft(action.event?.is_error ? "turn.failed" : "turn.completed", {
        event: action.event || null,
        assistant: action.event?.result || "",
        usage: action.event?.usage || action.event?.modelUsage || null,
      });
    case "runtime_error":
      return runtimeDraft("turn.failed", { event: action.event || null });
    case "hook_pretool_use_ask":
    case "hook_user_prompt_ask":
    case "hook_stop":
    case "hook_subagent_stop":
      return runtimeDraft("hook.requested", {
        requestId: action.requestId || "",
        hookName: action.hookName || "",
        toolName: action.toolName || "",
        toolInput: action.toolInput || null,
        decisionReason: action.decisionReason || "",
      });
    case "hook_pretool_use":
    case "hook_posttool_use":
    case "hook_posttool_use_failure":
    case "hook_session_start":
    case "hook_precompact":
    case "hook_user_prompt":
    case "hook_notification":
    case "hook_callback":
      return runtimeDraft("engine.notice", { notice: action.notice || null });
    case "stream_message_delta":
      if (action.usage && Object.keys(action.usage).length) {
        return runtimeDraft("usage.updated", {
          usage: action.usage,
          stopReason: action.stopReason || "",
        });
      }
      return runtimeDraft("engine.notice", {
        notice: { code: "messageDelta", stopReason: action.stopReason || "" },
      });
    case "stream_message_stop":
      return runtimeDraft("assistant.message_stop", {});
    case "prompt_suggestions":
      return runtimeDraft("prompt_suggestions.updated", {
        suggestions: action.suggestions || [],
      });
    case "control_response":
    case "initialize_request":
      return runtimeDraft("runtime.control", {
        kind: action.kind,
        requestId: action.requestId || "",
      });
    default:
      return runtimeDraft("engine.warning", {
        kind: action.kind || "unknown_action",
        notice: action.notice || null,
      });
  }
}

class CliEventAdapter {
  constructor() {
    this.name = "claude-cli";
  }

  normalizeEvent(ev) {
    const actions = normalizeClaudeEvent(ev);
    const runtimeEvents = actions
      .map((action) => runtimeEventFromAction(action))
      .filter(Boolean);
    const warnings = actions.filter(isWarningAction);
    const backgroundActivity = backgroundActivityFromEvent(ev);
    return {
      adapter: this.name,
      rawType: ev?.type || "",
      rawSubtype: ev?.subtype || "",
      actions,
      runtimeEvents,
      warnings,
      backgroundActivity,
    };
  }
}

module.exports = {
  CliEventAdapter,
  runtimeEventFromAction,
  isWarningAction,
};
