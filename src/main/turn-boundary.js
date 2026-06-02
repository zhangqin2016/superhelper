"use strict";

const {
  emitSessionEvents,
  buildTurnEndedEvent,
  buildUserCommittedEvent,
} = require("./session-events");
const {
  takeQueueItemIfIdle,
  requeueFront,
  emitQueueState,
} = require("./turn-message-queue");
const { turnController } = require("./turn-controller");
const { emitTurnState } = require("./session-turn-state");

async function dispatchQueuedItem(ctx, sessionId) {
  const item = takeQueueItemIfIdle(ctx, sessionId);
  if (!item) return { event: null };

  const session = ctx.sessionManager.findById(sessionId);
  if (!session) {
    requeueFront(sessionId, item);
    emitQueueState(ctx, sessionId);
    return { event: null };
  }

  const { dispatchUserLine, sendToRenderer } = require("./ipc-utils");
  const result = await dispatchUserLine(ctx, session, item.text, item.files, {
    recordUser: true,
    spawnEngine: true,
    fromQueue: true,
    displayFiles: item.displayFiles,
    skipSessionEvents: true,
  });

  if (result.ok && result.userCommitted) {
    emitQueueState(ctx, sessionId);
    return {
      event: buildUserCommittedEvent(
        sessionId,
        result.userCommitted.text,
        result.userCommitted.files,
        { fromQueue: true },
      ),
    };
  }

  requeueFront(sessionId, item);
  emitQueueState(ctx, sessionId);
  if (!result.ok) {
    sendToRenderer(ctx.mainWindow, "assistant:queue-dispatch-failed", {
      sessionId,
      error: result.error,
      detail: result.detail,
    });
  }
  return { event: null };
}

/**
 * Turn ended + optional queued user in one ordered session-events batch.
 * @param {object} ctx
 * @param {string} sessionId
 * @param {object} turnPayload
 */
async function emitTurnBoundary(ctx, sessionId, turnPayload) {
  const events = [buildTurnEndedEvent(sessionId, turnPayload)];

  turnController.finalizeTurn(sessionId);
  emitTurnState(ctx, sessionId);

  const queued = await dispatchQueuedItem(ctx, sessionId);
  if (queued.event) {
    events.push(queued.event);
  }

  emitSessionEvents(ctx, sessionId, events);
}

module.exports = {
  emitTurnBoundary,
  dispatchQueuedItem,
};
