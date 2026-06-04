"use strict";

const { parseCanUseToolRequest } = require("./control-protocol");
const {
  classifyEngineEvent,
  noticeForControlSubtype,
} = require("./engine-event-notices");

const SILENT_EVENT_TYPES = new Set([
  "keep_alive",
  "control_cancel_request",
]);

function normalizeAskUserQuestions(input = {}) {
  const rawQuestions = Array.isArray(input?.questions) ? input.questions : [];
  const normalized = rawQuestions
    .map((question, index) => normalizeAskUserQuestion(question, index))
    .filter(Boolean);
  if (normalized.length) return normalized;

  const fallbackText = [
    input.question,
    input.prompt,
    input.message,
    input.text,
    input.description,
    input.title,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean);

  return [
    {
      id: "answer",
      question: fallbackText || "请补充你的回答。",
      options: [],
      multiSelect: false,
    },
  ];
}

function normalizeAskUserQuestion(question, index) {
  if (typeof question === "string") {
    const text = question.trim();
    return text
      ? { id: `question_${index + 1}`, question: text, options: [], multiSelect: false }
      : null;
  }
  if (!question || typeof question !== "object") return null;

  const text = [
    question.question,
    question.prompt,
    question.message,
    question.text,
    question.header,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean);
  const id =
    typeof question.id === "string" && question.id.trim()
      ? question.id.trim()
      : `question_${index + 1}`;
  const options = Array.isArray(question.options)
    ? question.options
        .map((option) => {
          if (typeof option === "string") return { label: option.trim() };
          if (!option || typeof option !== "object") return null;
          const label =
            typeof option.label === "string" && option.label.trim()
              ? option.label.trim()
              : typeof option.value === "string" && option.value.trim()
                ? option.value.trim()
                : "";
          if (!label) return null;
          return {
            label,
            description:
              typeof option.description === "string" ? option.description.trim() : "",
          };
        })
        .filter(Boolean)
    : [];

  return {
    ...question,
    id,
    question: text || `问题 ${index + 1}`,
    options,
    multiSelect: Boolean(question.multiSelect || question.multi_select),
  };
}

function controlSubtype(ev) {
  return ev?.request?.subtype || ev?.subtype || "";
}

function controlRequestId(ev) {
  return (
    ev?.request_id ||
    (typeof ev?.request?.request_id === "string" ? ev.request.request_id : "") ||
    ""
  );
}

function normalizeControlEvent(ev) {
  const canUse = parseCanUseToolRequest(ev);
  if (canUse) {
    if (canUse.toolName === "AskUserQuestion") {
      const questions = normalizeAskUserQuestions(canUse.input || {});
      return [{ kind: "ask_user_question", ...canUse, questions }];
    }
    return [{ kind: "permission_check", ...canUse }];
  }

  const requestId = controlRequestId(ev);
  const subtype = controlSubtype(ev);
  if (requestId && subtype === "initialize") {
    return [{
      kind: "initialize_request",
      requestId,
      suggestions:
        ev.request?.prompt_suggestions ||
        ev.request?.suggestions ||
        ev.request?.promptSuggestions ||
        [],
    }];
  }
  if (requestId && subtype === "hook_callback") {
    return [{
      kind: "hook_callback",
      requestId,
      hookEvent:
        ev.request?.hook_event && typeof ev.request.hook_event === "object"
          ? ev.request.hook_event
          : {},
      notice: noticeForControlSubtype(subtype),
    }];
  }
  if (requestId) {
    return [{
      kind: "unknown_control_request",
      requestId,
      subtype,
      notice: noticeForControlSubtype(subtype),
    }];
  }
  return [{
    kind: "protocol_warning",
    notice: {
      code: "unknownEvent",
      level: "warning",
      panel: true,
      done: true,
      type: ev.type || "control_request",
      subtype: subtype || "missing_request_id",
    },
  }];
}

function normalizeAssistantMessage(ev) {
  const blocks = Array.isArray(ev?.message?.content) ? ev.message.content : [];
  const actions = [];
  for (const block of blocks) {
    if (block?.type === "text") {
      actions.push({ kind: "assistant_text", text: block.text || "" });
    } else if (block?.type === "tool_use") {
      actions.push({
        kind: "assistant_tool_use",
        id: block.id || "",
        name: block.name || "unknown",
        input: block.input || {},
        parentToolUseId: ev.parent_tool_use_id || null,
      });
    }
  }
  return actions;
}

function normalizeUserMessage(ev) {
  const blocks = Array.isArray(ev?.message?.content) ? ev.message.content : [];
  return blocks
    .filter((block) => block?.type === "tool_result")
    .map((block) => ({
      kind: "tool_result",
      id: block.tool_use_id || "",
      isError: Boolean(block.is_error),
      content: Array.isArray(block.content)
        ? block.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n")
        : null,
    }));
}

function normalizeStreamEvent(ev) {
  const inner = ev?.event;
  if (!inner) return [];
  switch (inner.type) {
    case "message_start":
      return [{ kind: "stream_message_start" }];
    case "content_block_start": {
      const block = inner.content_block;
      if (block?.type !== "tool_use" || !block.id || !block.name) return [];
      return [{
        kind: "stream_tool_start",
        index: typeof inner.index === "number" ? inner.index : -1,
        id: block.id,
        name: block.name,
        input: block.input || {},
        parentToolUseId: ev.parent_tool_use_id || null,
      }];
    }
    case "content_block_delta": {
      const delta = inner.delta;
      if (delta?.type === "text_delta") {
        return [{ kind: "assistant_text", text: delta.text || "" }];
      }
      if (delta?.type === "input_json_delta" && delta.partial_json) {
        return [{
          kind: "stream_tool_input_delta",
          index: typeof inner.index === "number" ? inner.index : -1,
          partialJson: delta.partial_json,
        }];
      }
      return [];
    }
    case "content_block_stop":
      return [{
        kind: "stream_content_block_stop",
        index: typeof inner.index === "number" ? inner.index : -1,
      }];
    case "message_stop":
      return [{ kind: "stream_message_stop" }];
    default:
      return [];
  }
}

function normalizeClaudeEvent(ev) {
  if (!ev || typeof ev !== "object" || !ev.type) return [];
  if (SILENT_EVENT_TYPES.has(ev.type)) {
    if (ev.type === "control_cancel_request") {
      return [{ kind: "control_cancel", requestId: ev.request_id || ev.request?.request_id || "" }];
    }
    return [];
  }

  switch (ev.type) {
    case "system": {
      const subtype = String(ev.subtype || "");
      const notice = classifyEngineEvent(ev);
      if (!notice && subtype && !subtype.startsWith("task_") && subtype !== "thinking_tokens") {
        return [{
          kind: "protocol_warning",
          notice: {
            code: "unknownEvent",
            level: "warning",
            panel: true,
            done: true,
            type: "system",
            subtype,
          },
        }];
      }
      return [{
        kind: "system_notice",
        subtype,
        sessionId: ev.session_id || "",
        notice,
      }];
    }
    case "rate_limit_event":
    case "tool_use_summary":
      return [{ kind: "engine_notice", notice: classifyEngineEvent(ev) }];
    case "assistant":
      return normalizeAssistantMessage(ev);
    case "user":
      return normalizeUserMessage(ev);
    case "stream_event":
      return normalizeStreamEvent(ev);
    case "tool_progress":
      return [{
        kind: "engine_notice",
        notice: {
          code: "toolProgress",
          level: "progress",
          panel: true,
          replace: true,
          detail: String(ev.message || ev.summary || "").slice(0, 160),
          toolName: ev.tool_name || "",
        },
      }];
    case "prompt_suggestion":
    case "prompt_suggestions":
      return [{
        kind: "prompt_suggestions",
        suggestions: ev.suggestions || ev.prompt_suggestions || [],
      }];
    case "result":
      return [{ kind: "turn_result", event: ev }];
    case "error":
      return [{ kind: "runtime_error", event: ev }];
    case "control_request":
    case "sdk_control_request":
      return normalizeControlEvent(ev);
    default: {
      const notice = classifyEngineEvent(ev) || {
        code: "unknownEvent",
        level: "warning",
        panel: true,
        done: true,
        type: String(ev.type || "unknown"),
        subtype: typeof ev.subtype === "string" ? ev.subtype : undefined,
      };
      if (notice.code === "unknownEvent") notice.level = "warning";
      return [{ kind: "unknown_runtime_event", notice, event: ev }];
    }
  }
}

module.exports = {
  normalizeClaudeEvent,
  normalizeAskUserQuestions,
};
