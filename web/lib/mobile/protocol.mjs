// Mobile Command phone protocol — the phone's side.
//
// Mirrors the phone layer of the desktop's src/main/mobile/protocol.js (a
// contract test holds the names equal). The protocol evolves additively, so
// this page also understands desktops of earlier releases: every field it
// relies on beyond the original set is optional.

export const PHONE_PROTOCOL = 1;

/** Phone → desktop. */
export const FROM_PHONE = Object.freeze({
  COMMAND: "command",
  INTERRUPT: "interrupt",
  SESSION_REQUEST: "session.request",
  SESSIONS_REQUEST: "sessions.request",
  SESSION_SELECT: "session.select",
  PROJECTS_REQUEST: "projects.request",
  PROJECT_SELECT: "project.select",
  PROMPT_RESPOND: "prompt.respond",
  SESSION_CREATE: "session.create",
});

/** Desktop → phone. */
export const TO_PHONE = Object.freeze({
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
});

/** Relay → phone. */
export const FROM_RELAY = Object.freeze({
  READY: "relay.ready",
  PRESENCE: "relay.presence",
  PEER_OFFLINE: "relay.peer_offline",
});

/** Close codes the relay uses on purpose. */
export const CLOSE = Object.freeze({ REPLACED: 4000, GRANT_ENDED: 4001 });

function randomId() {
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  }
}

export const toDesktop = {
  command({ text, attachments = [], mobileDeviceId, lilySessionId }) {
    const commandId = `cmd_${randomId()}`;
    return {
      type: FROM_PHONE.COMMAND,
      commandId,
      // Visually distinct from the command id, for support diagnostics.
      correlationId: `corr_${commandId.slice(4, 14)}`,
      idempotencyKey: commandId,
      protocolVersion: PHONE_PROTOCOL,
      text,
      attachments,
      mobileDeviceId,
      mode: "queue",
      lilySessionId: lilySessionId || "",
    };
  },
  interrupt() {
    return { type: FROM_PHONE.INTERRUPT, correlationId: `corr_stop_${randomId().slice(0, 10)}` };
  },
  sessionRequest: () => ({ type: FROM_PHONE.SESSION_REQUEST }),
  sessionsRequest: () => ({ type: FROM_PHONE.SESSIONS_REQUEST }),
  projectsRequest: () => ({ type: FROM_PHONE.PROJECTS_REQUEST }),
  selectSession: (sessionId) => ({ type: FROM_PHONE.SESSION_SELECT, sessionId }),
  selectProject: (projectId) => ({ type: FROM_PHONE.PROJECT_SELECT, projectId }),
  createSession: () => ({ type: FROM_PHONE.SESSION_CREATE }),
  /** Answer a prompt: `action` for a permission / plan / hook, `answers` (one per question) for a question. */
  respondPrompt: ({ requestId, action, answers }) => ({ type: FROM_PHONE.PROMPT_RESPOND, requestId, ...(action ? { action } : {}), ...(answers ? { answers } : {}) }),
};
