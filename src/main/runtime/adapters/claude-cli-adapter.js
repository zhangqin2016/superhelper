"use strict";

const { normalizeClaudeEvent } = require("./claude-event-normalizer");
const { backgroundActivityFromEvent } = require("../runtime-activity");

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

function normalizeEchoText(text = "") {
  return String(text || "").trim().replace(/\s+/g, " ");
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

class CliEventAdapter {
  constructor(options = {}) {
    this.name = "claude-cli";
    this.cliVersion = options.cliVersion || null;
    this.versionText = options.versionText || "";
    this._activeStreamMessageId = "";
    this._streamedTextMessageIds = new Set();
    this._activeStreamText = "";
    this._recentStreamTexts = [];
    /**
     * Engine capability declaration. The orchestration layer must degrade per
     * capability instead of assuming every engine behaves like Claude CLI
     * (e.g. an engine without streamInput is restarted per turn; one without
     * emitsThinking simply renders no thinking blocks — never fake them).
     */
    this.capabilities = Object.freeze({
      /** Long-lived process accepts stream-json user messages on stdin. */
      streamInput: true,
      /** Emits thinking deltas that map to assistant.thinking.delta. */
      emitsThinking: true,
      /** Supports update_environment_variables control hot-swap. */
      hotEnvUpdate: true,
      /** Asks the host for tool permission decisions (canUseTool). */
      permissionControl: true,
      /** Supports --resume style conversation continuation. */
      resume: true,
      /** CLI can disable all customizations for troubleshooting. */
      safeMode: Boolean(options.capabilities?.safeMode),
      /** CLI documents/supports Fable model alias family. */
      fableModelAlias: Boolean(options.capabilities?.fableModelAlias),
      /** CLI may emit top-level rate_limit_event telemetry. */
      rateLimitEvent: Boolean(options.capabilities?.rateLimitEvent),
    });
  }

  _noteStreamEvent(ev) {
    const inner = ev?.event;
    if (!inner || typeof inner !== "object") return;
    if (inner.type === "message_start") {
      this._activeStreamMessageId = String(inner.message?.id || "");
      return;
    }
    if (inner.type === "content_block_start" && inner.content_block?.type === "text") {
      this._activeStreamText = String(inner.content_block?.text || "");
      return;
    }
    if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta" && this._activeStreamMessageId) {
      this._streamedTextMessageIds.add(this._activeStreamMessageId);
      this._activeStreamText += String(inner.delta?.text || "");
      return;
    }
    if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta") {
      this._activeStreamText += String(inner.delta?.text || "");
      return;
    }
    if (inner.type === "content_block_stop" && this._activeStreamText) {
      this._rememberStreamText(this._activeStreamText);
      this._activeStreamText = "";
      return;
    }
    if (inner.type === "message_stop") {
      if (this._activeStreamText) {
        this._rememberStreamText(this._activeStreamText);
        this._activeStreamText = "";
      }
      this._activeStreamMessageId = "";
    }
  }

  _rememberStreamText(text) {
    const normalized = normalizeEchoText(text);
    if (!normalized) return;
    this._recentStreamTexts.push(normalized);
    if (this._recentStreamTexts.length > 8) {
      this._recentStreamTexts.splice(0, this._recentStreamTexts.length - 8);
    }
  }

  _isTranscriptTextEcho(text) {
    const normalized = normalizeEchoText(text);
    if (!normalized) return false;
    if (normalizeEchoText(this._activeStreamText) === normalized) return true;
    return this._recentStreamTexts.includes(normalized);
  }

  _filterTranscriptEchoes(ev, actions) {
    if (ev?.type !== "assistant" || !Array.isArray(actions) || actions.length === 0) return actions;
    const messageId = String(ev.message?.id || ev.id || "");
    const hasStreamedMessageText = Boolean(messageId && this._streamedTextMessageIds.has(messageId));
    return actions.filter((action) => {
      if (action?.kind !== "assistant_text") return true;
      return !(hasStreamedMessageText || this._isTranscriptTextEcho(action.text || ""));
    });
  }

  normalizeEvent(ev) {
    this._noteStreamEvent(ev);
    const actions = this._filterTranscriptEchoes(ev, normalizeClaudeEvent(ev));
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
