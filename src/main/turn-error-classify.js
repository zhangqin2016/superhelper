"use strict";

/**
 * Pure turn-failure classification + failure-text extraction, factored out of
 * turn-orchestrator so it can be unit-tested in isolation (no electron, no
 * orchestrator state machine). Depends only on agent-runner's pure string
 * helpers. The orchestrator uses: classifyTurnFailure and
 * collectFailureTextFromState.
 */

const { sanitizeError, classifyAssistantError, scrubVendorNames } = require("./agent-runner");

function compactFailureDetail(raw) {
  const text = scrubVendorNames(raw).replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 260 ? `${text.slice(0, 260)}…` : text;
}

function looksLikeLeakedToolCallText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  const compact = text.replace(/\s+/g, " ");
  const markers = [
    /<\/?tool_call\b/i,
    /<\/?function(?:=|\b)/i,
    /<\/?parameter(?:=|\b)/i,
  ];
  const hits = markers.filter((pattern) => pattern.test(compact)).length;
  if (!hits) return false;
  const stripped = compact
    .replace(/>\s*/g, " ")
    .replace(/<\/?tool_call[^>]*>/gi, " ")
    .replace(/<\/?function[^>]*>/gi, " ")
    .replace(/<\/?parameter[^>]*>/gi, " ")
    .replace(/[<>{}/=_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return hits >= 2 || stripped.length <= 80;
}

function failureTextFromProcessEvent(event = {}) {
  const rawSubtype = String(event.rawSubtype || event.event?.subtype || "");
  const rawType = String(event.rawType || event.event?.type || "");
  const values = [];
  const raw = event.event || {};
  if (typeof raw.error === "string") values.push(raw.error);
  if (Array.isArray(raw.errors)) values.push(raw.errors.join("\n"));
  if (typeof raw.message === "string" && (rawType === "error" || rawSubtype.startsWith("error"))) {
    values.push(raw.message);
  }
  if (rawSubtype.startsWith("error")) values.push(rawSubtype);
  for (const action of event.actions || []) {
    if (typeof action?.notice?.detail === "string") values.push(action.notice.detail);
    if (typeof action?.notice?.message === "string") values.push(action.notice.message);
  }
  return values.filter(Boolean).join("\n");
}

function failureTextFromNoticeEvent(event = {}) {
  const notice = event.payload?.notice || event.notice || event.payload || event;
  if (!notice || typeof notice !== "object") return "";
  const level = String(notice.level || "");
  const code = String(notice.code || "");
  if (level !== "warning" && !/error|fail|denied|timeout/i.test(code)) return "";
  return [notice.detail, notice.message, code].filter((value) => typeof value === "string" && value.trim()).join("\n");
}

/** Most recent failure-bearing text from the turn's process events + notices. */
function collectFailureTextFromState(state = {}) {
  const parts = [];
  for (const event of [...(state.processEvents || [])].reverse()) {
    const text = failureTextFromProcessEvent(event);
    if (text) {
      parts.push(text);
      break;
    }
  }
  for (const event of [...(state.notices || [])].reverse()) {
    const text = failureTextFromNoticeEvent(event);
    if (text) {
      parts.push(text);
      break;
    }
  }
  return parts.join("\n");
}

function isFailedToolStatus(status) {
  return ["failed", "error", "cancelled", "canceled", "timeout"].includes(String(status || "").toLowerCase());
}

function isDoneToolStatus(status) {
  return ["done", "completed", "success"].includes(String(status || "").toLowerCase());
}

function compactToolLabel(tool = {}) {
  const rawInput = tool.input && typeof tool.input === "object" ? tool.input : {};
  const candidate = rawInput.description
    || rawInput.title
    || rawInput.prompt
    || rawInput.command
    || rawInput.url
    || rawInput.path
    || tool.name
    || tool.id
    || "工具";
  const text = String(candidate || "").replace(/\s+/g, " ").trim();
  if (!text) return "工具";
  return text.length > 72 ? `${text.slice(0, 72)}…` : text;
}

function compactToolResultPreview(result, limit = 900) {
  if (result == null) return "";
  const values = [];
  if (typeof result === "string") {
    values.push(result);
  } else if (Array.isArray(result)) {
    values.push(result.map((item) => (
      typeof item === "string" ? item : JSON.stringify(item)
    )).join("\n"));
  } else if (typeof result === "object") {
    for (const key of ["output", "content", "text", "summary", "message", "error"]) {
      if (typeof result[key] === "string" && result[key].trim()) values.push(result[key]);
    }
    if (!values.length) {
      try { values.push(JSON.stringify(result)); } catch {}
    }
  }
  const text = values.join("\n").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

function collectToolCompletionSnapshot(state = {}) {
  const tools = Array.from(state.tools?.values?.() || []);
  const done = [];
  const failed = [];
  const running = [];
  for (const tool of tools) {
    const item = {
      id: tool.id || "",
      name: tool.name || "",
      label: compactToolLabel(tool),
      status: tool.status || "running",
      resultPreview: compactToolResultPreview(tool.result, isDoneToolStatus(tool.status) ? 1200 : 420),
    };
    if (isDoneToolStatus(tool.status)) done.push(item);
    else if (isFailedToolStatus(tool.status)) failed.push(item);
    else running.push(item);
  }
  return { done, failed, running, count: tools.length };
}

function isEmptyAssistantCompletion(payload = {}, normalized = {}, state = {}) {
  if (normalized?.failed) return false;
  const text = String(normalized?.text || state?.assistantText || "").trim();
  if (text) return false;
  if (payload?.interruptedByUser || payload?.userInterrupted || payload?.stalled || payload?.engineInterrupted) return false;
  if (payload?.code && payload.code !== 0) return false;
  return true;
}

function listToolLabels(title, items, limit = 6, { includeResult = false } = {}) {
  if (!items.length) return "";
  const lines = [`${title}：`];
  for (const item of items.slice(0, limit)) {
    const suffix = item.name && item.name !== item.label ? `（${item.name}）` : "";
    lines.push(`- ${item.label}${suffix}`);
    if (includeResult && item.resultPreview) {
      lines.push(indentPreview(item.resultPreview));
    }
  }
  if (items.length > limit) lines.push(`- 另外 ${items.length - limit} 个`);
  return lines.join("\n");
}

function indentPreview(text) {
  const lines = String(text || "").trim().split("\n").slice(0, 24);
  if (!lines.length) return "";
  return lines.map((line) => `  ${line}`).join("\n");
}

function buildIncompleteTurnSummary(state = {}, payload = {}) {
  const snapshot = collectToolCompletionSnapshot(state);
  const hasToolSignal = snapshot.count > 0;
  const failureText = compactFailureDetail(
    collectFailureTextFromState(state)
    || payload?.error
    || payload?.errorText
    || payload?.message
    || "",
  );
  if (!hasToolSignal && !failureText) {
    return "当前模型没有返回任何可用内容，所以本轮没有形成回答。请检查模型是否可用、模型名称/API 地址/密钥/兼容参数是否正确；如果刚修改过模型配置，请重新发起一次。";
  }

  const parts = [
    "本轮没有形成完整最终回答。系统已停止继续等待，避免会话一直卡在处理中。",
  ];
  if (snapshot.failed.length || snapshot.running.length) {
    parts.push("原因：有子任务或工具未完成/失败，父任务没有进入最终回答阶段。");
  } else if (snapshot.done.length) {
    parts.push("原因：子任务已有执行结果，但父任务没有完成最终汇总。");
  }
  if (failureText) parts.push(`最后错误/提示：${failureText}`);
  const failed = listToolLabels("未完成或失败的子任务", [...snapshot.failed, ...snapshot.running], 6, {
    includeResult: true,
  });
  if (failed) parts.push(failed);
  const done = listToolLabels("已完成的子任务和已保留结果", snapshot.done, 4, {
    includeResult: true,
  });
  if (done) parts.push(done);
  parts.push("可以直接继续提问，我会基于上面的已完成结果补齐汇总，并优先只重跑未完成/失败的部分。");
  return parts.join("\n\n");
}

function appendIncompleteTurnSummary(assistantText, state = {}, payload = {}) {
  const existing = String(assistantText || "").trim();
  const summary = buildIncompleteTurnSummary(state, payload);
  if (!existing) return summary;
  if (existing.includes("本轮没有形成完整最终回答") || existing.includes("本轮没有形成最终回答")) {
    return existing;
  }
  return `${existing}\n\n---\n\n${summary}`;
}

/**
 * Classify a turn failure into { code, message, retryable } or null when the
 * turn did not fail.
 */
function classifyTurnFailure(payload, normalized, state) {
  const rawError = [
    payload?.error,
    payload?.errorText,
    payload?.message,
    payload?.resultSubtype,
    collectFailureTextFromState(state),
  ].filter((value) => typeof value === "string" && value.trim()).join("\n");
  const errorClassified = classifyAssistantError(rawError);
  if (errorClassified) return errorClassified;
  const assistantLikeText = [normalized?.text, state?.assistantText]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
  const thinkingLikeText = String(state?.thinkingText || "");
  if (looksLikeLeakedToolCallText(assistantLikeText) || looksLikeLeakedToolCallText(thinkingLikeText)) {
    return {
      code: "MALFORMED_TOOL_CALL_TEXT",
      message: "The model returned an incomplete tool-call fragment instead of a final answer. Please retry; if it repeats, refresh the model configuration or start a fresh conversation.",
      retryable: true,
      category: "protocol",
    };
  }
  if (isEmptyAssistantCompletion(payload, normalized, state)) {
    return {
      code: "EMPTY_ASSISTANT_COMPLETION",
      message: "当前模型不可用或没有返回可用内容。本轮没有形成回答，请检查模型服务状态、模型名称、API 地址、密钥和兼容参数。",
      retryable: true,
      category: "protocol",
      suppressIncompleteSummary: true,
    };
  }
  if (normalized?.failed) {
    return {
      code: normalized.errorCode || "ASSISTANT_ERROR",
      message: normalized.text || sanitizeError(collectFailureTextFromState(state)) || "The assistant engine encountered an error. Please retry.",
      retryable: normalized.retryable !== false,
    };
  }
  if (payload?.engineInterrupted) {
    return {
      code: "ENGINE_INTERRUPTED",
      message: "The assistant engine interrupted this response. Please retry.",
      retryable: true,
    };
  }
  if (payload?.code && payload.code !== 0) {
    return {
      code: payload?.source === "process.close" ? "ENGINE_PROCESS_EXITED" : "ENGINE_RESULT_FAILED",
      message: rawError
        ? `Assistant engine returned failure: ${compactFailureDetail(rawError)}`
        : "Assistant process exited unexpectedly. Please retry. If this persists, restart the application.",
      retryable: true,
    };
  }
  return null;
}

module.exports = {
  collectFailureTextFromState,
  buildIncompleteTurnSummary,
  appendIncompleteTurnSummary,
  collectToolCompletionSnapshot,
  classifyTurnFailure,
  // exported for focused testing
  compactFailureDetail,
  compactToolResultPreview,
  failureTextFromProcessEvent,
  failureTextFromNoticeEvent,
  isEmptyAssistantCompletion,
  looksLikeLeakedToolCallText,
};
