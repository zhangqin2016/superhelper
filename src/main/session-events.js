"use strict";

/** @typedef {"turn-ended"|"user-committed"} SessionEventType */

/** @type {Map<string, number>} */
const sessionSeq = new Map();

function nextSeq(sessionId) {
  const n = (sessionSeq.get(sessionId) || 0) + 1;
  sessionSeq.set(sessionId, n);
  return n;
}

/**
 * @param {import('electron').BrowserWindow | null | undefined} mainWindow
 * @param {string} channel
 * @param {unknown} payload
 */
function sendToRenderer(mainWindow, channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

/**
 * Ordered transcript mutations — renderer applies batch atomically.
 * @param {object} ctx
 * @param {string} sessionId
 * @param {Array<Record<string, unknown>>} events
 */
function emitSessionEvents(ctx, sessionId, events) {
  if (!sessionId || !events?.length) return;
  sendToRenderer(ctx.mainWindow, "assistant:session-events", {
    sessionId,
    seq: nextSeq(sessionId),
    events,
  });
}

/**
 * @param {string} sessionId
 * @param {object} payload
 */
function buildTurnEndedEvent(sessionId, payload) {
  return {
    type: "turn-ended",
    sessionId,
    turnId: payload.turnId ?? null,
    endReason: payload.endReason ?? "completed",
    interrupted: Boolean(payload.interrupted),
    stalled: Boolean(payload.stalled),
    hadOutput: Boolean(payload.hadOutput),
    assistant: payload.assistant ?? null,
  };
}

/**
 * @param {string} sessionId
 * @param {string} text
 * @param {unknown[] | null} files
 * @param {{ fromQueue?: boolean, immediate?: boolean }} [opts]
 */
function buildUserCommittedEvent(sessionId, text, files, opts = {}) {
  return {
    type: "user-committed",
    sessionId,
    text: String(text || "").trim(),
    files: files?.length ? files : null,
    fromQueue: Boolean(opts.fromQueue),
    immediate: Boolean(opts.immediate),
  };
}

module.exports = {
  emitSessionEvents,
  buildTurnEndedEvent,
  buildUserCommittedEvent,
};
