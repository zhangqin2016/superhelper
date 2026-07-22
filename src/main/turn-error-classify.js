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
  // Model tool-call CONTROL TOKENS leaking as text. These use special delimiters
  // that never occur in real prose: a DSML marker and/or full-width ｜ (U+FF5C) /
  // ▁ bars, e.g. `<｜｜DSML｜｜tool_calls>` / `<｜｜DSML｜｜invoke name="bash">` /
  // `<｜｜DSML｜｜parameter …>`. The tag name is NOT right after `<` here (the
  // delimiter sits in between), so the tag-name markers below miss it — flag on
  // sight instead. Any occurrence is unambiguously a leak.
  if (/[｜|▁]{1,3}\s*DSML\s*[｜|▁]{1,3}/i.test(text)) return true;
  if (/<\s*[｜｜|▁]{1,3}[^<>]{0,48}\b(?:tool_calls?|invoke|parameter|function)\b/i.test(text)) return true;
  const compact = text.replace(/\s+/g, " ");
  const markers = [
    // tool_call AND tool_calls (plural); the old `tool_call\b` missed the plural
    // opener `<tool_calls>` that Anthropic-style leaks use.
    /<\/?tool_calls?\b/i,
    // Anthropic-style invoke opener (optionally namespaced), the sibling of the
    // <parameter> tags in a leaked `<tool_calls><invoke name="…"><parameter …>` blob.
    /<\/?(?:[a-z]+:)?invoke\b/i,
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
    return "当前模型没有返回任何可用内容，所以本轮没有形成回答。常见原因：模型网关对本次请求返回了错误页（内容不是模型输出，多见于自建/代理网关处理不了携带工具的请求）、模型名称/API 地址/密钥/兼容参数不正确。可在模型设置里重新保存该模型触发兼容性检测；如果刚修改过模型配置，请重新发起一次。";
  }

  const parts = [
    "本轮没有形成完整最终回答。系统已停止继续等待，避免会话一直卡在处理中。",
  ];
  // Honesty first: a stall while a permission/question card is still open is
  // not "the model hung" — the turn died waiting for the user (the 2026-07-22
  // field case: an rm -rf permission card sat unanswered for 20 minutes).
  if (Number(state?.pendingPermissions?.size || 0) > 0 || Number(state?.pendingQuestions?.size || 0) > 0) {
    parts.push("本轮中止时仍在等待你确认授权或回复：有操作需要你点击允许才能继续。重新发送任务，并在弹出确认卡片时及时处理（或切换到全自主模式自动允许）。");
  }
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
  // Check each candidate INDIVIDUALLY as well as joined: normalized.text and
  // state.assistantText usually carry the SAME leaked fragment, and the joined
  // duplicate doubles the stripped length past the short-fragment heuristic —
  // exactly the single-marker `<tool_call>` leaks weak models produce.
  const leakCandidates = [assistantLikeText, normalized?.text, state?.assistantText, thinkingLikeText];
  if (leakCandidates.some((value) => looksLikeLeakedToolCallText(value))) {
    return {
      code: "MALFORMED_TOOL_CALL_TEXT",
      message: "The model returned an incomplete tool-call fragment instead of a final answer. Please retry; if it repeats, refresh the model configuration or start a fresh conversation.",
      retryable: true,
      category: "protocol",
    };
  }
  // Mid-turn stream truncation: the FINAL message ended with an unrecognized
  // finish reason while earlier steps in the SAME turn reported real ones
  // ("tool-calls"/"stop") — the gateway cut the stream, usually right as the
  // model announced its next action, and the engine mistakes the silence for
  // a clean turn end. Evidence-gated three ways so healthy gateways never trip
  // it: (1) this turn PROVED the gateway emits recognized reasons, (2) the
  // final reason is "unknown", (3) tools ran (mid-task, not a chat answer).
  // Kill switch: LILY_TRUNCATED_END_GUARD=0.
  if (
    process.env.LILY_TRUNCATED_END_GUARD !== "0" &&
    state?.lastStopReason === "unknown" &&
    state?.sawRecognizedStopReason &&
    (state?.tools?.size || 0) > 0 &&
    !payload?.interruptedByUser && !payload?.userInterrupted && !payload?.stalled && !payload?.engineInterrupted
  ) {
    return {
      code: "TRUNCATED_TURN_END",
      message: "模型响应流在中途被截断，本轮工作没有完成（已完成的步骤结果已保留）。常见原因是模型网关连接不稳定。可以直接重试，或继续提问让我接着做。",
      retryable: true,
      category: "model",
    };
  }
  // Micro-completion: the gateway glitches and the content channel leaks a
  // stray fragment as the whole answer — a sentence tail ("…file paths, and a
  // single research question", 9 tokens) or even CODE from an earlier task
  // ("paragraphs.push(p2('7.4 …'));\nparagraph", 18 tokens, to "hi"). Evidence
  // gates keep legitimate short answers safe: no tools ran, gateway-reported
  // output is tiny, the text does NOT end like a finished sentence, AND the
  // fragment carries a continuation signature — code syntax without a fence,
  // a lowercase latin mid-sentence start, or a few-token reply to a
  // non-trivial ask. Kill switch: LILY_MICRO_COMPLETION_GUARD=0.
  if (process.env.LILY_MICRO_COMPLETION_GUARD !== "0" && (state?.tools?.size || 0) === 0) {
    const text = String(normalized?.text || state?.assistantText || "").trim();
    // Evidence-first: only the gateway's own usage accounting counts — no
    // usage data, no classification (synthetic/edge turns stay untouched).
    const outputTokens = Number(state?.usage?.output_tokens);
    const tinyOutput = Number.isFinite(outputTokens) && outputTokens > 0 && outputTokens <= 24;
    const endsLikeSentence = /[。．.!?！?…"”』」)）\]】:：]$/.test(text);
    const userAsk = String(state?.enginePayload?.rawText || "").trim();
    const userAskNonTrivial = userAsk.length >= 8;
    const codeShaped = !text.includes("```") &&
      (/[;{}]\s*$/.test(text) || /\)\);|=>|\\n/.test(text));
    const latinMidSentenceStart = /^[a-z]/.test(text) && /[,;]/.test(text);
    // An unpaired ** is a document cut mid-bold-run, never a finished answer
    // ("ily-csv-conversion (CSV 转换)**", 11 tokens, to "你好" — the fragment
    // was a bolded list item from OUR OWN system guide with its head cut off).
    const danglingMarkdown = ((text.match(/\*\*/g) || []).length % 2) === 1;
    // Our internal skill namespace appearing unprompted is a system-prompt
    // echo — the user never typed "lily-…", so the content channel leaked the
    // injected guide instead of an answer.
    const promptEcho = /\blily-[a-z0-9][a-z0-9-]*/i.test(text) && !/lily-/i.test(userAsk);
    const fragmentSignature = codeShaped || latinMidSentenceStart || danglingMarkdown || promptEcho ||
      (Number.isFinite(outputTokens) && outputTokens <= 12 && userAskNonTrivial);
    if (text && tinyOutput && !endsLikeSentence && fragmentSignature &&
        !payload?.interruptedByUser && !payload?.userInterrupted && !payload?.stalled && !payload?.engineInterrupted) {
      return {
        code: "MICRO_COMPLETION",
        message: "模型只返回了一个不完整的句子片段，本轮没有形成有效回答。常见原因是网关的思考模式处理异常吞掉了正文。可以直接重试。",
        retryable: true,
        category: "model",
      };
    }
  }
  if (isEmptyAssistantCompletion(payload, normalized, state)) {
    return {
      code: "EMPTY_ASSISTANT_COMPLETION",
      message: "当前模型不可用或没有返回可用内容。本轮没有形成回答。常见原因：模型网关对本次请求返回了错误页（内容不是模型输出，多见于自建/代理网关处理不了携带工具的请求）、模型服务状态/模型名称/API 地址/密钥/兼容参数有问题。可在模型设置里重新保存该模型触发兼容性检测。",
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
