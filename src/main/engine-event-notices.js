"use strict";

/**
 * Map Claude CLI stream-json events to user-visible engine notices (panel + optional toast).
 * Keeps office users informed of compaction, retries, rate limits, etc.
 */

/** @typedef {{ code: string, level: "info" | "progress" | "warning", panel?: boolean, toast?: boolean, replace?: boolean, replacesCode?: string, done?: boolean, detail?: string, attempt?: number, maxRetries?: number, model?: string, subtype?: string, type?: string }} EngineNotice */

const TASK_PROGRESS_SUBTYPES = new Set([
  "task_updated",
  "task_progress",
  "task_notification",
  "status",
]);

function compactValue(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object") return "";

  const keys = [
    "message",
    "summary",
    "detail",
    "title",
    "name",
    "description",
    "status",
    "current_step",
    "currentStep",
    "step",
  ];
  for (const key of keys) {
    const text = compactValue(value[key]);
    if (text) return text;
  }
  return "";
}

function extractTaskDetail(ev) {
  const values = [
    ev.message,
    ev.summary,
    ev.detail,
    ev.title,
    ev.name,
    ev.description,
    ev.status,
    ev.current_step,
    ev.currentStep,
    ev.step,
    ev.task,
    ev.progress,
  ];
  const detail = values.map(compactValue).find(Boolean);
  return detail ? detail.slice(0, 180) : "";
}

function formatTokenCount(value) {
  const tokens = Number(value) || 0;
  if (tokens <= 0) return "";
  if (tokens >= 1000) {
    const rounded = Math.round(tokens / 100) / 10;
    return `${rounded}k tokens`;
  }
  return `${tokens} tokens`;
}

function isRequestingStatus(ev) {
  return String(ev?.subtype || "") === "status" &&
    String(ev?.status || "").trim().toLowerCase() === "requesting";
}

/**
 * @param {Record<string, unknown>} ev
 * @returns {EngineNotice | null}
 */
function classifyEngineEvent(ev) {
  if (!ev || typeof ev !== "object") return null;

  switch (ev.type) {
    case "system":
      return classifySystemEvent(ev);
    case "rate_limit_event":
      return {
        code: "rateLimit",
        level: "progress",
        panel: true,
        replace: true,
      };
    case "tool_use_summary":
      if (typeof ev.summary === "string" && ev.summary.trim()) {
        return {
          code: "toolSummary",
          level: "info",
          panel: true,
          detail: ev.summary.trim().slice(0, 160),
          done: true,
        };
      }
      return null;
    default:
      return classifyFallbackEvent(ev);
  }
}

/**
 * @param {Record<string, unknown>} ev
 * @returns {EngineNotice | null}
 */
function classifySystemEvent(ev) {
  const subtype = String(ev.subtype || "");

  switch (subtype) {
    case "init":
      return {
        code: "sessionReady",
        level: "info",
        panel: false,
        done: true,
        model: typeof ev.model === "string" ? ev.model : "",
      };
    case "compact_boundary":
      return {
        code: "compactBoundary",
        level: "progress",
        panel: true,
        replace: true,
      };
    case "compact_complete":
    case "compact_completed":
      return {
        code: "compactComplete",
        level: "info",
        panel: true,
        replace: true,
        replacesCode: "compactBoundary",
        done: true,
      };
    case "api_retry": {
      const attempt = Number(ev.attempt) || 1;
      const maxRetries = Number(ev.max_retries ?? ev.maxRetries) || 0;
      const err = typeof ev.error === "string" ? ev.error : "";
      return {
        code: "apiRetry",
        level: "progress",
        panel: true,
        replace: true,
        attempt,
        maxRetries,
        detail: err || undefined,
      };
    }
    case "thinking_tokens": {
      const tokens = formatTokenCount(ev.estimated_tokens ?? ev.tokens ?? ev.total_tokens);
      const delta = formatTokenCount(ev.estimated_tokens_delta ?? ev.tokens_delta);
      return {
        code: "thinkingProgress",
        level: "progress",
        panel: true,
        replace: true,
        detail: tokens || delta,
        subtype,
      };
    }
    case "permission_denied":
      return {
        code: "permissionDenied",
        level: "warning",
        panel: true,
        replace: true,
        done: true,
        detail: extractTaskDetail(ev),
        subtype,
      };
    case "task_started":
      return {
        code: "taskProgress",
        level: "progress",
        panel: true,
        replace: true,
        detail: extractTaskDetail(ev),
        subtype,
      };
    case "task_completed":
      return {
        code: "taskCompleted",
        level: "info",
        panel: true,
        replace: true,
        replacesCode: "taskProgress",
        done: true,
        detail: extractTaskDetail(ev),
        subtype,
      };
    case "task_failed":
      return {
        code: "taskFailed",
        level: "warning",
        panel: true,
        replace: true,
        replacesCode: "taskProgress",
        done: true,
        detail: extractTaskDetail(ev),
        subtype,
      };
    default:
      if (isRequestingStatus(ev)) {
        return {
          code: "thinkingProgress",
          level: "progress",
          panel: true,
          replace: true,
          detail: "",
          subtype,
        };
      }
      if (TASK_PROGRESS_SUBTYPES.has(subtype)) {
        return {
          code: "taskProgress",
          level: "progress",
          panel: true,
          replace: true,
          detail: extractTaskDetail(ev),
          subtype,
        };
      }
      if (!subtype) return null;
      // Unknown system subtypes are CLI internals — do not append a card per event.
      return null;
  }
}

/**
 * @param {Record<string, unknown>} ev
 * @returns {EngineNotice | null}
 */
function classifyFallbackEvent(ev) {
  const type = String(ev.type || "");
  if (!type) return null;

  const knownSilent = new Set([
    "assistant",
    "user",
    "stream_event",
    "result",
    "keep_alive",
    "prompt_suggestion",
    "prompt_suggestions",
    "control_cancel_request",
    "control_request",
    "sdk_control_request",
    "tool_progress",
    "error",
  ]);
  if (knownSilent.has(type)) return null;

  return {
    code: "unknownEvent",
    level: "info",
    panel: true,
    done: true,
    type,
    subtype: typeof ev.subtype === "string" ? ev.subtype : undefined,
  };
}

/**
 * @param {string} controlSubtype
 * @returns {EngineNotice | null}
 */
function noticeForControlSubtype(controlSubtype) {
  if (!controlSubtype) return null;
  // hook_callback now handled by per-hook-kind notices in claude-event-normalizer
  if (controlSubtype === "hook_callback") return null;
  if (controlSubtype === "initialize") return null;
  if (controlSubtype === "can_use_tool") return null;
  return {
    code: "controlRequest",
    level: "info",
    panel: true,
    done: true,
    subtype: controlSubtype,
  };
}

module.exports = {
  classifyEngineEvent,
  noticeForControlSubtype,
};
