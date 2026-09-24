"use strict";

/**
 * Mirrors desktop sessions onto the phones watching them.
 *
 * Two products, both from the desktop's own sources:
 *   snapshot(sessionId) — the conversation exactly as the chat view shows it
 *                         (desktop-port.readConversation → conversation-view),
 *                         plus the live phase and the running turn;
 *   live frames         — runtime events of a session, as the phone renders
 *                         them, sent to every phone whose target is that
 *                         session, and a fresh snapshot once a turn settles.
 *
 * Frames never carry tool inputs, file contents or metadata — only text the
 * desktop already shows its user.
 */

const { mobileConversationView } = require("./conversation-view");
const { toPhone } = require("./protocol");

const TERMINAL_STATUS = Object.freeze({
  "turn.completed": "completed",
  "turn.failed": "failed",
  "turn.interrupted": "interrupted",
  "turn.stalled": "stalled",
});

/** Readable text of an `assistant` payload (the runtime sends a string). */
function assistantText(assistant) {
  if (typeof assistant === "string") return assistant;
  if (!assistant || typeof assistant !== "object") return "";
  if (typeof assistant.text === "string") return assistant.text;
  if (typeof assistant.content === "string") return assistant.content;
  if (Array.isArray(assistant.content)) return assistant.content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("");
  return "";
}

/**
 * A runtime event of `sessionId` as the phone frame it becomes, or null.
 * `commandIdOf(turnId)` names the phone command a turn came from.
 */
function phoneFrameForEvent(event, sessionId, commandIdOf = () => "") {
  if (!event || typeof event !== "object") return null;
  const turnId = event.turnId || null;
  const payload = event.payload || {};
  switch (event.type) {
    case "turn.started":
      return toPhone.turnStarted({
        turnId,
        sessionId,
        userText: payload.text,
        files: Array.isArray(payload.files) ? payload.files.length : 0,
        commandId: turnId ? commandIdOf(turnId) : "",
      });
    case "assistant.delta":
      return payload.text ? toPhone.assistantDelta({ turnId, sessionId, text: String(payload.text) }) : null;
    case "assistant.final": {
      const text = assistantText(payload.assistant);
      return text ? toPhone.assistantFinal({ turnId, sessionId, text }) : null;
    }
    case "tool.started": {
      const tool = payload.name || payload.tool || payload.title || "";
      return tool ? toPhone.toolStarted({ turnId, sessionId, tool }) : null;
    }
    default: {
      const status = TERMINAL_STATUS[event.type];
      return status ? toPhone.turnEnded({ turnId, sessionId, status, text: assistantText(payload.assistant) }) : null;
    }
  }
}

/**
 * @param {object} opts
 * @param {object} opts.port                    desktop port
 * @param {() => Iterable<object>} opts.controllers  live phone controllers
 * @param {(grantId: string, frame: object) => void} opts.send
 */
function createSessionMirror({ port, controllers, send, log = { warn() {} } }) {
  let unsubscribe = null;

  async function snapshot(sessionId) {
    const session = sessionId ? port.findSession(sessionId) : null;
    if (!session) return null;
    const live = port.turnState(session.id);
    let view = { items: [], truncated: false };
    try {
      view = mobileConversationView(await port.readConversation(session.id), { runningTurnId: live.runningTurnId });
    } catch (err) {
      log.warn("mobile snapshot read failed: %s", err?.message || err);
    }
    return toPhone.sessionContext({ session, ...live, items: view.items, truncated: view.truncated });
  }

  function watchersOf(sessionId) {
    const out = [];
    for (const controller of controllers()) {
      if (controller.targetSessionId() === sessionId) out.push(controller.grantId);
    }
    return out;
  }

  function onRuntime(sessionId, events) {
    const watchers = watchersOf(sessionId);
    if (!watchers.length) return;
    let settled = false;
    for (const event of events || []) {
      const frame = phoneFrameForEvent(event, sessionId, (turnId) => port.turnCommandId(sessionId, turnId));
      if (!frame) continue;
      for (const grantId of watchers) send(grantId, frame);
      if (frame.type === "turn.ended") settled = true;
    }
    // Once a turn settles the conversation changed: send it as the desktop
    // now shows it, this turn included.
    if (settled) {
      void snapshot(sessionId).then((frame) => {
        if (!frame) return;
        for (const grantId of watchersOf(sessionId)) send(grantId, frame);
      });
    }
  }

  return {
    snapshot,
    start() {
      if (!unsubscribe) unsubscribe = port.observeRuntime(onRuntime);
    },
    stop() {
      try { unsubscribe?.(); } catch { /* noop */ }
      unsubscribe = null;
    },
  };
}

module.exports = { createSessionMirror, phoneFrameForEvent, assistantText, TERMINAL_STATUS };
