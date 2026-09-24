"use strict";

/**
 * How one runtime event changes a turn's projection — pure, no database.
 *
 * The projection is the durable copy of a turn WHILE it runs: every streamed
 * delta is folded in at insert time, which is what lets the deltas themselves
 * be pruned once the turn ends. It is therefore also the only copy of what a
 * turn produced if the app dies before the turn is archived.
 *
 * Two things this adds to the reducer that lived inline in the store:
 *
 *   - What streamed is never overwritten by a platform notice. A turn killed
 *     mid-run is recovered as `turn.dispatch_outcome_unknown`, and that branch
 *     used to REPLACE the accumulated answer with "本次回复的持久化结果无法确认…"
 *     — 2026-09-24, a 38-minute, 224-tool turn reopened as that one sentence,
 *     its 90 KB of thinking still in the row beside it. The notice now lives
 *     beside the content, not over it.
 *   - The order of what streamed. Text, thinking and tool calls interleave;
 *     the projection kept only their sums. `payload.blocks` records the
 *     sequence as offsets into the accumulated text (never a second copy of
 *     it) and tool ids, so a turn with no archived record can still be shown
 *     the way it ran. Once a turn ends with an archived record, that record is
 *     the source and the blocks are dropped, so settled rows stay small.
 */

const {
  DISPATCH_OUTCOME_UNKNOWN_ASSISTANT,
  DISPATCH_BLOCKED_ASSISTANT,
} = require("../turn-recovery-projection");
const { applyTerminalPayload, isTerminalEventType } = require("./turn-projection-payload");

// Endings that leave no archived record behind: the projection IS the turn.
const RECOVERY_ENDINGS = new Set(["turn.dispatch_outcome_unknown", "turn.dispatch_blocked"]);

function emptyProjection(sessionId, turnId, now) {
  return {
    sessionId,
    turnId,
    status: "running",
    userText: "",
    assistantText: "",
    thinkingText: "",
    activityLabel: null,
    toolCount: 0,
    noticeCount: 0,
    startedAt: null,
    updatedAt: now,
    terminalAt: null,
    terminalType: null,
    payload: {},
  };
}

function normalizeProjectionUserMessage(message = {}) {
  const text = String(message.text ?? message.content ?? "");
  if (!text.trim()) return null;
  const steer = Boolean(message.steer || message.meta?.steer);
  const steerSeq = message.steerSeq ?? message.meta?.steerSeq ?? null;
  return {
    text,
    files: Array.isArray(message.files) ? message.files : null,
    ts: Number.isFinite(message.ts) ? message.ts : null,
    ...(steer ? { steer: true, steerSeq } : {}),
  };
}

function projectionUserMessages(projection = {}) {
  const payload = projection.payload && typeof projection.payload === "object"
    ? projection.payload
    : {};
  const messages = Array.isArray(payload.userMessages)
    ? payload.userMessages.map(normalizeProjectionUserMessage).filter(Boolean)
    : [];
  if (!messages.some((message) => !message.steer) && String(projection.userText || "").trim()) {
    messages.unshift({ text: String(projection.userText || ""), files: null, ts: projection.startedAt || null });
  }
  return messages;
}

function upsertProjectionUserMessage(projection, nextMessage) {
  const normalized = normalizeProjectionUserMessage(nextMessage);
  if (!normalized) return;
  const messages = projectionUserMessages(projection);
  let index = -1;
  if (normalized.steer) {
    const seqKey = normalized.steerSeq == null ? "" : String(normalized.steerSeq);
    index = messages.findIndex((message) => {
      if (!message.steer) return false;
      const messageSeqKey = message.steerSeq == null ? "" : String(message.steerSeq);
      if (seqKey && messageSeqKey) return messageSeqKey === seqKey;
      return message.text === normalized.text;
    });
  } else {
    index = messages.findIndex((message) => !message.steer);
  }
  if (index >= 0) messages[index] = { ...messages[index], ...normalized };
  else messages.push(normalized);
  projection.payload = {
    ...(projection.payload || {}),
    userMessages: messages,
  };
}

/** Extend the last block when it is the same kind, otherwise start one. */
function markSpan(projection, kind, from, to) {
  if (to <= from) return;
  const blocks = Array.isArray(projection.payload?.blocks) ? projection.payload.blocks : [];
  const last = blocks[blocks.length - 1];
  if (last && last.k === kind && last.b === from) last.b = to;
  else blocks.push({ k: kind, a: from, b: to });
  projection.payload = { ...(projection.payload || {}), blocks };
}

function markTool(projection, id) {
  if (!id) return;
  const blocks = Array.isArray(projection.payload?.blocks) ? projection.payload.blocks : [];
  blocks.push({ k: "tool", id: String(id) });
  projection.payload = { ...(projection.payload || {}), blocks };
}

/**
 * Apply `event` to `projection` (mutated and returned).
 * @param {object} projection hydrated projection, or emptyProjection(...)
 * @param {{ type: string, id?: string, ts?: number, payload?: object }} event
 */
function reduceProjection(projection, event) {
  const now = Number.isFinite(event.ts) ? event.ts : Date.now();
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const scheduledDraft =
    payload.scheduledDraft ||
    payload.record?.meta?.scheduledDraft ||
    payload.meta?.scheduledDraft ||
    null;

  projection.updatedAt = now;
  if (event.type === "turn.started") {
    projection.status = "running";
    projection.userText = String(payload.text || projection.userText || "");
    projection.startedAt = projection.startedAt || now;
    upsertProjectionUserMessage(projection, {
      text: projection.userText,
      files: payload.files || null,
      ts: projection.startedAt || now,
    });
  } else if (event.type === "user.committed") {
    const userText = String(payload.text || "");
    if (payload.steer) {
      upsertProjectionUserMessage(projection, {
        text: userText,
        files: payload.files || null,
        ts: now,
        steer: true,
        steerSeq: payload.steerSeq ?? null,
      });
    } else {
      projection.userText = String(userText || projection.userText || "");
      upsertProjectionUserMessage(projection, {
        text: projection.userText,
        files: payload.files || null,
        ts: projection.startedAt || now,
      });
    }
  } else if (event.type === "assistant.delta") {
    const from = projection.assistantText.length;
    projection.assistantText += String(payload.text || "");
    markSpan(projection, "text", from, projection.assistantText.length);
  } else if (event.type === "assistant.final") {
    projection.assistantText = String(payload.assistant || projection.assistantText || "");
  } else if (event.type === "assistant.thinking.delta") {
    const from = projection.thinkingText.length;
    projection.thinkingText += String(payload.text || "");
    markSpan(projection, "think", from, projection.thinkingText.length);
  } else if (event.type === "tool.started") {
    projection.toolCount += 1;
    projection.activityLabel = payload.name ? String(payload.name) : projection.activityLabel;
    markTool(projection, payload.id);
  } else if (event.type === "engine.notice" || event.type === "engine.warning" || event.type === "engine.stderr") {
    projection.noticeCount += 1;
  } else if (RECOVERY_ENDINGS.has(event.type)) {
    projection.status = event.type === "turn.dispatch_blocked" ? "dispatch_blocked" : "outcome_unknown";
    projection.terminalType = event.type;
    projection.terminalAt = now;
    // The notice goes to payload.assistant below; what streamed stays.
  } else if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted" || event.type === "turn.stalled") {
    projection.status = event.type.replace("turn.", "");
    projection.terminalType = event.type;
    projection.terminalAt = now;
    if (payload.assistant) projection.assistantText = String(payload.assistant);
  }
  const recoveryNotice = RECOVERY_ENDINGS.has(event.type)
    ? String(payload.assistant || (event.type === "turn.dispatch_blocked" ? DISPATCH_BLOCKED_ASSISTANT : DISPATCH_OUTCOME_UNKNOWN_ASSISTANT))
    : "";
  projection.payload = {
    ...(projection.payload || {}),
    lastEventType: event.type,
    lastEventId: event.id,
    ...(scheduledDraft ? { scheduledDraft } : {}),
    ...(RECOVERY_ENDINGS.has(event.type) ? {
      assistant: recoveryNotice,
      recoveryId: payload.recoveryId || "",
      manualRecoveryRequired: payload.manualRecoveryRequired !== false,
      automaticReplay: payload.automaticReplay === true,
      retryable: payload.retryable !== false && event.type === "turn.dispatch_blocked",
      errorCode: payload.errorCode || (event.type === "turn.dispatch_blocked" ? "DISPATCH_BLOCKED" : "DISPATCH_OUTCOME_UNKNOWN"),
    } : {}),
  };
  if (isTerminalEventType(event.type)) {
    projection.payload = applyTerminalPayload(projection.payload, payload, event.type);
    // An ending that archives a record supersedes the running sequence.
    const { blocks: _settled, ...rest } = projection.payload;
    projection.payload = rest;
  }
  return projection;
}

/**
 * Rebuild the turn a projection describes, for a turn with no archived record.
 *
 * @param {object} projection
 * @param {Array<{ type: string, payload: object }>} toolEvents this turn's
 *   persisted tool.started / tool.done events (never pruned)
 * @returns {{ assistantText: string, timeline: object[], tools: object[], notices: object[] }}
 */
function projectedRecordParts(projection = {}, toolEvents = []) {
  const streamed = String(projection.assistantText || "");
  const thinking = String(projection.thinkingText || "");
  const notice = RECOVERY_ENDINGS.has(projection.terminalType) ? String(projection.payload?.assistant || "") : "";
  const tools = new Map();
  for (const event of toolEvents) {
    const data = event?.payload || {};
    if (!data.id) continue;
    const current = tools.get(data.id) || { id: data.id, name: "Tool", input: {}, status: "running", result: null };
    if (event.type === "tool.started") {
      Object.assign(current, { name: data.name || current.name, input: data.input || {}, preview: data.preview || data.input?.preview || "" });
    } else if (event.type === "tool.done") {
      Object.assign(current, { status: data.isError ? "failed" : (data.status || "done"), result: data.result ?? null, isError: Boolean(data.isError) });
    }
    tools.set(data.id, current);
  }
  // A tool still "running" in a turn that has ended did not finish.
  const ended = Boolean(projection.terminalType);
  const toolList = [...tools.values()].map((tool) => (ended && tool.status === "running" ? { ...tool, status: "interrupted" } : tool));
  const byId = new Map(toolList.map((tool) => [tool.id, tool]));

  const timeline = [];
  let textCount = 0;
  let thinkCount = 0;
  for (const block of Array.isArray(projection.payload?.blocks) ? projection.payload.blocks : []) {
    if (block.k === "text") {
      const text = streamed.slice(block.a, block.b);
      if (/\S/.test(text)) timeline.push({ kind: "text", id: `text_${++textCount}`, text, status: "done" });
    } else if (block.k === "think") {
      const text = thinking.slice(block.a, block.b);
      if (/\S/.test(text)) timeline.push({ kind: "thinking", id: `think_${++thinkCount}`, text, status: "done", collapsed: true });
    } else if (block.k === "tool" && byId.has(block.id)) {
      const tool = byId.get(block.id);
      timeline.push({ kind: "tool", id: tool.id, name: tool.name, preview: tool.preview || "", input: tool.input, status: tool.status, result: tool.result });
    }
  }
  return {
    assistantText: streamed.trim() || notice,
    timeline,
    tools: toolList,
    notices: streamed.trim() && notice ? [{ code: projection.terminalType === "turn.dispatch_blocked" ? "dispatchBlocked" : "dispatchOutcomeUnknown", level: "warning", detail: notice }] : [],
  };
}

module.exports = {
  emptyProjection,
  projectedRecordParts,
  projectionUserMessages,
  reduceProjection,
  upsertProjectionUserMessage,
};
