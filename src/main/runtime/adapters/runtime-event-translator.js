"use strict";

/**
 * Engine-neutral translator: maps the normalized *action* vocabulary (produced
 * by an engine's event normalizer) into runtime-event drafts consumed by the
 * orchestration layer. Actions are already engine-agnostic, so this layer has no
 * Claude/OpenCode protocol knowledge — each adapter stamps its own `source`.
 */

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
    source: payload.source || "runtime",
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
    case "assistant_supersedes":
      return runtimeDraft("assistant.supersedes", {
        supersedes: action.supersedes || "",
        messageId: action.messageId || "",
      });
    case "assistant_thinking":
      return runtimeDraft("assistant.thinking.delta", { text: action.text || "" });
    case "assistant_image":
      return runtimeDraft("content.block", {
        blockType: "image",
        mediaType: action.mediaType || "image/png",
        data: action.data || "",
      });
    case "unknown_runtime_event":
    case "protocol_warning":
    case "unknown_control_request":
      return runtimeDraft("protocol.unknown", {
        kind: action.kind || "unknown_runtime_event",
        notice: action.notice || null,
        event: action.event || null,
      });
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
    case "stream_metadata_delta":
      return runtimeDraft("stream.metadata", {
        index: action.index,
        deltaType: action.deltaType || "",
      });
    case "stream_content_block_stop":
      return null;
    case "tool_result":
      return runtimeDraft("tool.done", {
        id: action.id || "",
        isError: Boolean(action.isError),
        content: action.content || null,
      });
    case "permission_check":
      return null;
    case "ask_user_question":
      return null;
    case "user_input_request":
      return null;
    case "turn_result":
    case "runtime_error":
      return null;
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
    case "hook_pretool_use_ask":
    case "hook_user_prompt_ask":
    case "hook_permission_request_ask":
    case "hook_elicitation_ask":
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
    case "hook_posttool_batch":
    case "hook_session_start":
    case "hook_session_end":
    case "hook_precompact":
    case "hook_postcompact":
    case "hook_user_prompt":
    case "hook_user_prompt_expansion":
    case "hook_notification":
    case "hook_stop_failure":
    case "hook_subagent_start":
    case "hook_permission_request":
    case "hook_permission_denied":
    case "hook_setup":
    case "hook_teammate_idle":
    case "hook_task_created":
    case "hook_task_completed":
    case "hook_elicitation":
    case "hook_elicitation_result":
    case "hook_config_change":
    case "hook_worktree_create":
    case "hook_worktree_remove":
    case "hook_instructions_loaded":
    case "hook_cwd_changed":
    case "hook_file_changed":
    case "hook_message_display":
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
    case "control_request":
      return runtimeDraft("runtime.control", {
        kind: action.kind,
        requestId: action.requestId || "",
        subtype: action.subtype || "",
      });
    default:
      return runtimeDraft("engine.warning", {
        kind: action.kind || "unknown_action",
        notice: action.notice || null,
      });
  }
}

module.exports = {
  WARNING_ACTION_KINDS,
  isWarningAction,
  runtimeDraft,
  runtimeEventFromAction,
};
