"use strict";

const { cancelAutoRecovery } = require("./turn-auto-recovery");
const {
  clearMessageQueue,
  emitQueueState,
  enqueueMessage,
} = require("./turn-message-queue");
const { turnController } = require("./turn-controller");
const { emitTurnState, turnState } = require("./session-turn-state");
const { hasSendableContent } = require("./user-message");

function queuedFilesFromDisplay(files, displayFiles) {
  return Array.isArray(displayFiles) && displayFiles.length ? displayFiles : files;
}

async function finishInterruptedTurnIfSettled(ctx, session, runner, hadTurn) {
  if (!hadTurn || runner?.isBusy()) return null;

  const { turnId, output, wasActive } = turnController.completeTurn(
    session.id,
    "interrupted",
  );
  let assistantPayload = null;
  if (wasActive && output?.trim()) {
    ctx.sessionManager.pushMessageTo(session.id, "assistant", output.trim());
    assistantPayload = { text: output.trim(), failed: false };
  }

  emitTurnState(ctx, session.id);

  const { emitTurnBoundary } = require("./turn-boundary");
  await emitTurnBoundary(ctx, session.id, {
    turnId,
    endReason: "interrupted",
    interrupted: true,
    stalled: false,
    hadOutput: Boolean(output?.trim()),
    assistant: assistantPayload,
  });

  return {
    turnId,
    hadOutput: Boolean(output?.trim()),
  };
}

/**
 * Interrupt the active turn and make this message the next turn.
 * Existing queued messages are intentionally discarded.
 */
async function interruptAndSend(ctx, session, text, files = [], opts = {}) {
  if (!session?.id) return { ok: false, error: "NO_SESSION" };
  if (!hasSendableContent(text, files)) return { ok: false, error: "EMPTY" };

  const { diagnoseSendBlocker, dispatchUserLine } = require("./ipc-utils");
  const blocked = diagnoseSendBlocker(ctx, session.id);
  if (blocked) return { ok: false, error: blocked.error, detail: blocked.detail };

  const runner = ctx.runnerPool.get(session.id);
  const hadTurn = turnState.has(session.id);
  const runnerBusy = Boolean(runner?.isBusy());

  if (!hadTurn && !runnerBusy) {
    return await dispatchUserLine(ctx, session, text, files, {
      recordUser: true,
      spawnEngine: true,
      displayFiles: opts.displayFiles,
    });
  }

  cancelAutoRecovery(session.id);
  clearMessageQueue(session.id);
  const queueLength = enqueueMessage(session.id, {
    text,
    files,
    displayFiles: queuedFilesFromDisplay(files, opts.displayFiles),
  });
  emitQueueState(ctx, session.id);

  if (hadTurn) {
    turnController.transition(session.id, "userInterrupt");
    emitTurnState(ctx, session.id);
  }

  runner?.interrupt();

  const settled = await finishInterruptedTurnIfSettled(ctx, session, runner, hadTurn);
  if (settled) {
    const { sendToRenderer } = require("./ipc-utils");
    sendToRenderer(ctx.mainWindow, "assistant:done", {
      code: null,
      sessionId: session.id,
      turnId: settled.turnId,
      interrupted: true,
      stalled: false,
      hadOutput: settled.hadOutput,
    });
  }

  return {
    ok: true,
    interrupted: true,
    queued: true,
    priority: true,
    queueLength,
  };
}

module.exports = {
  interruptAndSend,
  finishInterruptedTurnIfSettled,
};
