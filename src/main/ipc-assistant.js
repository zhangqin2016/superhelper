"use strict";

const fs = require("node:fs");
const { ipcMain } = require("electron");
const {
  sendToRenderer,
  turnState,
  emitTurnState,
  dispatchUserLine,
} = require("./ipc-utils");
const { turnController } = require("./turn-controller");
const { cancelAutoRecovery } = require("./turn-auto-recovery");
const { clearMessageQueue, emitQueueState, removeQueuedMessage, queueLength } = require("./turn-message-queue");
const { interruptAndSend, finishInterruptedTurnIfSettled } = require("./interrupt-and-send");
const { requireValidLicense } = require("./license-manager");

function registerAssistantHandlers(ctx) {
  const { sessionManager, runnerPool, projectManager } = ctx;

  ipcMain.handle("assistant:input", async (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const text = typeof payload === "string" ? payload : payload.text;
    const files = typeof payload === "object" && payload.files ? payload.files : [];
    const requestedId =
      typeof payload === "object" && payload?.sessionId ? payload.sessionId : null;

    let session = requestedId
      ? sessionManager.findById(requestedId)
      : sessionManager.getActive();
    if (!session) return { ok: false, error: "NO_SESSION" };

    if (requestedId && requestedId !== sessionManager.activeSessionId) {
      sessionManager.switchTo(requestedId);
    }
    const { projectManager } = ctx;
    if (session.projectId !== projectManager.getActive()?.id) {
      projectManager.switchTo(session.projectId);
    }

    const displayFiles =
      typeof payload === "object" && Array.isArray(payload.displayFiles)
        ? payload.displayFiles
        : [];

    return await dispatchUserLine(ctx, session, text, files, {
      recordUser: true,
      spawnEngine: true,
      displayFiles,
    });
  });

  ipcMain.handle("assistant:interrupt-and-send", async (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const text = typeof payload === "string" ? payload : payload.text;
    const files = typeof payload === "object" && payload.files ? payload.files : [];
    const requestedId =
      typeof payload === "object" && payload?.sessionId ? payload.sessionId : null;

    let session = requestedId
      ? sessionManager.findById(requestedId)
      : sessionManager.getActive();
    if (!session) return { ok: false, error: "NO_SESSION" };

    if (requestedId && requestedId !== sessionManager.activeSessionId) {
      sessionManager.switchTo(requestedId);
    }
    if (session.projectId !== projectManager.getActive()?.id) {
      projectManager.switchTo(session.projectId);
    }

    const displayFiles =
      typeof payload === "object" && Array.isArray(payload.displayFiles)
        ? payload.displayFiles
        : [];

    return await interruptAndSend(ctx, session, text, files, {
      displayFiles,
    });
  });

  ipcMain.handle("assistant:retry", async (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const sessionId = payload?.sessionId || sessionManager.getActive()?.id;
    const session = sessionId ? sessionManager.findById(sessionId) : null;
    if (!session) return { ok: false, error: "NO_SESSION" };

    const lastUser = sessionManager.getLastUserMessage(session.id);
    if (!lastUser) return { ok: false, error: "NO_USER_MESSAGE" };

    const lastMsg = session.messages[session.messages.length - 1];
    if (lastMsg?.role !== "assistant") {
      return { ok: false, error: "NOTHING_TO_RETRY" };
    }

    const storedFiles = lastUser.files || [];
    const files = [];
    const missing = [];
    for (const f of storedFiles) {
      if (f.path && fs.existsSync(f.path)) {
        files.push(f);
      } else if (storedFiles.length > 0) {
        missing.push(f.name || f.path || "file");
      }
    }
    if (storedFiles.length > 0 && files.length !== storedFiles.length) {
      return {
        ok: false,
        error: "FILES_UNAVAILABLE",
        detail: missing.length
          ? `附件已失效：${missing.join("、")}`
          : "原消息含附件，但路径已不可用，请重新添加附件后发送。",
      };
    }

    sessionManager.popLastAssistantMessage(session.id);

    const result = await dispatchUserLine(ctx, session, lastUser.content, files, {
      recordUser: false,
      spawnEngine: true,
    });
    if (!result.ok) {
      sessionManager.pushMessageTo(
        session.id,
        "assistant",
        lastMsg.content,
        lastMsg.files || null,
        lastMsg.failed ? { failed: true } : null,
      );
    }
    return result;
  });

  ipcMain.handle("assistant:permission-response", (_event, payload) => {
    const sessionId = payload?.sessionId || sessionManager.getActive()?.id;
    const requestId = payload?.requestId;
    if (!sessionId || !requestId) {
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const runner = runnerPool.get(sessionId);
    if (!runner) return { ok: false, error: "NO_RUNNER" };

    const handled = runner.respondPermission(requestId, {
      allow: Boolean(payload.allow),
      message: typeof payload.message === "string" ? payload.message : undefined,
      remember: Boolean(payload.remember),
    });
    return handled ? { ok: true, sessionId, requestId } : { ok: false, error: "NOT_PENDING" };
  });

  ipcMain.handle("assistant:turn-state:snapshot", (_event, payload) => {
    const sessionId = payload?.sessionId || sessionManager.getActive()?.id;
    if (!sessionId) return { ok: false, error: "NO_SESSION" };
    return { ok: true, ...turnController.snapshot(sessionId) };
  });

  ipcMain.handle("assistant:interrupt", async () => {
    const session = sessionManager.getActive();
    if (!session) return { ok: false, error: "NO_SESSION" };

    const runner = runnerPool.get(session.id);
    const hadTurn = turnState.has(session.id);

    cancelAutoRecovery(session.id);
    clearMessageQueue(session.id);
    emitQueueState(ctx, session.id);

    if (hadTurn) {
      turnController.transition(session.id, "userInterrupt");
      emitTurnState(ctx, session.id);
    }

    runner?.interrupt();

    const settled = await finishInterruptedTurnIfSettled(ctx, session, runner, hadTurn);
    if (settled) {
      sendToRenderer(ctx.mainWindow, "assistant:done", {
        code: null,
        sessionId: session.id,
        turnId: settled.turnId,
        interrupted: true,
        stalled: false,
        hadOutput: settled.hadOutput,
      });
    }

    return { ok: true };
  });

  ipcMain.handle("assistant:cancel-queued-message", (_event, payload) => {
    const sessionId = payload?.sessionId || sessionManager.getActive()?.id;
    const index = Number(payload?.index);
    if (!sessionId || !Number.isInteger(index) || index < 0) {
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const session = sessionManager.findById(sessionId);
    if (!session) return { ok: false, error: "NO_SESSION" };

    if (!removeQueuedMessage(sessionId, index)) {
      return { ok: false, error: "NOT_FOUND" };
    }

    emitQueueState(ctx, sessionId);
    return { ok: true, sessionId, queueLength: queueLength(sessionId) };
  });
}

module.exports = { registerAssistantHandlers };
