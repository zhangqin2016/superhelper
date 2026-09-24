"use strict";

/**
 * Mobile Command wire protocol — the desktop's single definition.
 *
 * Two layers:
 *   control — desktop ⇄ relay, over the desktop's one control channel.
 *             Server-pushed pairing events, and `relay.frame` envelopes that
 *             carry phone frames tagged with their pairing.
 *   phone   — desktop ⇄ phone, the frames inside those envelopes. Evolves
 *             ADDITIVELY: a field is added, never renamed, so a phone page
 *             and a desktop of different releases still understand each other.
 *
 * The phone page mirrors the phone layer in web/lib/mobile/protocol.mjs; a
 * contract test holds the two to the same names.
 */

const CONTROL_PROTOCOL = 2;
const PHONE_PROTOCOL = 1;

const CONTROL = Object.freeze({
  HELLO: "control.hello",
  PAIRING_PENDING: "control.pairing.pending",
  GRANT_ACTIVE: "control.grant.active",
  GRANT_ENDED: "control.grant.ended",
  PRESENCE: "control.presence",
  FRAME: "relay.frame",
  ERROR: "relay.error",
});

/** Close codes the relay uses on purpose; a client does not retry them blindly. */
const CLOSE = Object.freeze({ REPLACED: 4000, GRANT_ENDED: 4001 });

/** Phone → desktop. */
const FROM_PHONE = Object.freeze({
  COMMAND: "command",
  INTERRUPT: "interrupt",
  SESSION_REQUEST: "session.request",
  SESSIONS_REQUEST: "sessions.request",
  SESSION_SELECT: "session.select",
  PROJECTS_REQUEST: "projects.request",
  PROJECT_SELECT: "project.select",
  PROMPT_RESPOND: "prompt.respond",
  SESSION_CREATE: "session.create",
  FILE_REQUEST: "file.request",
});

/** Desktop → phone. */
const TO_PHONE = Object.freeze({
  COMMAND_ADMITTED: "command.admitted",
  COMMAND_REJECTED: "command.rejected",
  INTERRUPT_ACK: "interrupt.ack",
  SESSION_CONTEXT: "session.context",
  SESSIONS_LIST: "sessions.list",
  SESSION_SELECT_ACK: "session.select.ack",
  PROJECTS_LIST: "projects.list",
  PROJECT_SELECT_ACK: "project.select.ack",
  TURN_STARTED: "turn.started",
  ASSISTANT_DELTA: "assistant.delta",
  ASSISTANT_FINAL: "assistant.final",
  TOOL_STARTED: "tool.started",
  TURN_ENDED: "turn.ended",
  PROMPTS_UPDATED: "prompts.updated",
  PROMPT_ACK: "prompt.ack",
  TODOS_UPDATED: "todos.updated",
  FILE_START: "file.start",
  FILE_CHUNK: "file.chunk",
  FILE_ERROR: "file.error",
});

const LIMITS = Object.freeze({
  COMMAND_TEXT: 8000,
  ATTACHMENTS: 6,
  // The relay drops frames over 256 KB; outbound text is budgeted below it.
  FINAL_TEXT: 60_000,
  USER_TEXT: 4_000,
});

/** Parse a raw frame; null when it is not a JSON object with a type. */
function parseFrame(raw) {
  let frame = raw;
  if (typeof raw === "string" || Buffer.isBuffer(raw)) {
    try { frame = JSON.parse(String(raw)); } catch { return null; }
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame) || typeof frame.type !== "string") return null;
  return frame;
}

function envelope(grantId, frame) {
  return { type: CONTROL.FRAME, grantId: String(grantId), frame };
}

function capped(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const toPhone = {
  commandAdmitted(fields) {
    return { type: TO_PHONE.COMMAND_ADMITTED, ...fields };
  },
  commandRejected({ commandId, correlationId, code, detail }) {
    return {
      type: TO_PHONE.COMMAND_REJECTED,
      commandId: commandId || null,
      correlationId: correlationId || null,
      code,
      ...(detail ? { detail: String(detail).slice(0, 200) } : {}),
    };
  },
  interruptAck({ ok, correlationId, turnId, code }) {
    return {
      type: TO_PHONE.INTERRUPT_ACK,
      ok: Boolean(ok),
      correlationId: correlationId || null,
      turnId: turnId || null,
      ...(code ? { code } : {}),
    };
  },
  selectAck(kind, { id, code }) {
    return kind === "project"
      ? { type: TO_PHONE.PROJECT_SELECT_ACK, ok: false, projectId: id || "", code }
      : { type: TO_PHONE.SESSION_SELECT_ACK, ok: false, sessionId: id || "", code };
  },
  turnStarted({ turnId, sessionId, userText, files, commandId }) {
    return {
      type: TO_PHONE.TURN_STARTED,
      turnId: turnId || null,
      sessionId,
      ...(userText ? { userText: capped(userText, LIMITS.USER_TEXT) } : {}),
      ...(files ? { files } : {}),
      // The phone's own command when this turn is one, "" when it was typed on
      // the desktop. Always present: its presence tells the phone this desktop
      // names commands (so "" means "not yours"), and the phone reconciles its
      // "sending" copy by identity, never by comparing text.
      commandId: String(commandId || ""),
    };
  },
  assistantDelta({ turnId, sessionId, text }) {
    return { type: TO_PHONE.ASSISTANT_DELTA, turnId: turnId || null, sessionId, text };
  },
  assistantFinal({ turnId, sessionId, text }) {
    return { type: TO_PHONE.ASSISTANT_FINAL, turnId: turnId || null, sessionId, text: capped(text, LIMITS.FINAL_TEXT) };
  },
  toolStarted({ turnId, sessionId, tool }) {
    return { type: TO_PHONE.TOOL_STARTED, turnId: turnId || null, sessionId, tool: String(tool).slice(0, 60) };
  },
  turnEnded({ turnId, sessionId, status, text }) {
    return {
      type: TO_PHONE.TURN_ENDED,
      turnId: turnId || null,
      sessionId,
      status,
      ...(text ? { text: capped(text, LIMITS.FINAL_TEXT) } : {}),
    };
  },
  sessionContext({ session, phase, queueLength, runningTurnId, canInterrupt, items, truncated, prompts }) {
    return {
      type: TO_PHONE.SESSION_CONTEXT,
      sessionId: String(session?.id || ""),
      title: String(session?.title || ""),
      phase: String(phase || ""),
      queueLength: Number.isFinite(queueLength) ? queueLength : 0,
      ...(runningTurnId ? { runningTurnId } : {}),
      ...(canInterrupt ? { canInterrupt: true } : {}),
      recent: items,
      ...(truncated ? { truncated: true } : {}),
      // What the session waits on its user for — always present from a desktop
      // that sends it, so an empty list means "nothing to answer".
      prompts: Array.isArray(prompts) ? prompts : [],
    };
  },
  /** The turn's task list as the model wrote it (text + status only). */
  todosUpdated({ turnId, sessionId, todos }) {
    const list = (Array.isArray(todos) ? todos : []).slice(0, 30).map((todo) => ({
      text: capped(todo?.content ?? todo?.text ?? "", 200),
      status: ["completed", "in_progress", "cancelled"].includes(todo?.status) ? todo.status : "pending",
    })).filter((todo) => todo.text);
    return { type: TO_PHONE.TODOS_UPDATED, turnId: turnId || null, sessionId, todos: list };
  },
  promptsUpdated({ sessionId, prompts }) {
    return { type: TO_PHONE.PROMPTS_UPDATED, sessionId, prompts: Array.isArray(prompts) ? prompts : [] };
  },
  promptAck({ requestId, ok, code }) {
    return { type: TO_PHONE.PROMPT_ACK, requestId: String(requestId || ""), ok: Boolean(ok), ...(code ? { code } : {}) };
  },
  sessionsList({ projectId, activeSessionId, selectedSessionId, sessions }) {
    return { type: TO_PHONE.SESSIONS_LIST, projectId, activeSessionId, selectedSessionId, sessions };
  },
  projectsList({ activeProjectId, selectedProjectId, projects }) {
    return { type: TO_PHONE.PROJECTS_LIST, activeProjectId, selectedProjectId, projects };
  },
};

module.exports = {
  CLOSE,
  CONTROL,
  CONTROL_PROTOCOL,
  FROM_PHONE,
  LIMITS,
  PHONE_PROTOCOL,
  TO_PHONE,
  envelope,
  parseFrame,
  toPhone,
};
