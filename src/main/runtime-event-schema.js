"use strict";

const crypto = require("node:crypto");

const TERMINAL_EVENT_TYPES = new Set([
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.stalled",
]);

const USER_BLOCKING_EVENT_TYPES = new Set([
  "permission.requested",
  "user_question.requested",
  "hook.requested",
]);

const RUNTIME_EVENT_TYPES = new Set([
  "session.hydrated",
  "user.committed",
  "turn.started",
  "turn.accepted",
  "assistant.thinking.delta",
  "assistant.delta",
  "assistant.message_stop",
  "assistant.final",
  "process.event",
  "tool.started",
  "tool.input.delta",
  "tool.input.done",
  "tool.done",
  "permission.requested",
  "permission.resolved",
  "permission.timeout",
  "user_question.requested",
  "user_question.resolved",
  "hook.requested",
  "hook.resolved",
  "queue.updated",
  "recovery.scheduled",
  "recovery.started",
  "engine.notice",
  "engine.warning",
  "engine.stderr",
  "usage.updated",
  "resume.updated",
  "resume.invalid",
  "prompt_suggestions.updated",
  "runtime.control",
  "turn.completed",
  "turn.failed",
  "turn.interrupted",
  "turn.stalled",
]);

const TURN_OPTIONAL_TYPES = new Set([
  "session.hydrated",
  "resume.updated",
  "resume.invalid",
  "queue.updated",
  "user.committed",
  "engine.notice",
  "engine.warning",
  "engine.stderr",
  "prompt_suggestions.updated",
]);

function createRuntimeEvent(input) {
  const type = String(input?.type || "");
  if (!type) throw new Error("RuntimeEvent type is required");
  if (!RUNTIME_EVENT_TYPES.has(type)) throw new Error(`Unknown RuntimeEvent type: ${type}`);
  const sessionId = String(input?.sessionId || "");
  if (!sessionId) throw new Error(`RuntimeEvent ${type} requires sessionId`);
  const turnId = input?.turnId == null ? null : String(input.turnId);
  if (!turnId && !TURN_OPTIONAL_TYPES.has(type)) {
    throw new Error(`RuntimeEvent ${type} requires turnId`);
  }

  const event = {
    id: input.id || `evt_${crypto.randomUUID()}`,
    type,
    sessionId,
    turnId,
    seq: Number.isInteger(input.seq) ? input.seq : 0,
    ts: Number.isFinite(input.ts) ? input.ts : Date.now(),
    source: input.source || "runtime",
    payload: input.payload && typeof input.payload === "object" ? input.payload : {},
  };
  assertRuntimeEvent(event);
  return event;
}

function assertRuntimeEvent(event) {
  if (!event || typeof event !== "object") throw new Error("Invalid RuntimeEvent");
  if (!event.id || typeof event.id !== "string") throw new Error("RuntimeEvent id is required");
  if (!event.type || typeof event.type !== "string") throw new Error("RuntimeEvent type is required");
  if (!RUNTIME_EVENT_TYPES.has(event.type)) throw new Error(`Unknown RuntimeEvent type: ${event.type}`);
  if (!event.sessionId || typeof event.sessionId !== "string") throw new Error("RuntimeEvent sessionId is required");
  if (!Number.isInteger(event.seq)) throw new Error("RuntimeEvent seq must be an integer");
  if (!Number.isFinite(event.ts)) throw new Error("RuntimeEvent ts must be a timestamp");
  if (!event.payload || typeof event.payload !== "object") throw new Error("RuntimeEvent payload must be an object");
  if (!event.turnId && !TURN_OPTIONAL_TYPES.has(event.type)) {
    throw new Error(`RuntimeEvent ${event.type} requires turnId`);
  }
  return true;
}

function isTerminalEvent(event) {
  return TERMINAL_EVENT_TYPES.has(event?.type);
}

function isUserBlockingEvent(event) {
  return USER_BLOCKING_EVENT_TYPES.has(event?.type);
}

module.exports = {
  TERMINAL_EVENT_TYPES,
  USER_BLOCKING_EVENT_TYPES,
  RUNTIME_EVENT_TYPES,
  createRuntimeEvent,
  assertRuntimeEvent,
  isTerminalEvent,
  isUserBlockingEvent,
};
