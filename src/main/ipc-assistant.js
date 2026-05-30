"use strict";

const fs = require("node:fs");
const { ipcMain } = require("electron");
const {
  sendToRenderer,
  activeTurns,
  turnOutputs,
  dispatchUserLine,
  warmupActiveRunner,
} = require("./ipc-utils");

function registerAssistantHandlers(ctx) {
  const { sessionManager, runnerPool } = ctx;

  ipcMain.handle("assistant:input", (_event, payload) => {
    const text = typeof payload === "string" ? payload : payload.text;
    const files = typeof payload === "object" && payload.files ? payload.files : [];

    const session = sessionManager.getActive();
    if (!session) return { ok: false, error: "NO_SESSION" };

    return dispatchUserLine(ctx, session, text, files, { recordUser: true });
  });

  ipcMain.handle("assistant:retry", (_event, payload) => {
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

    const result = dispatchUserLine(ctx, session, lastUser.content, files, {
      recordUser: false,
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

  ipcMain.handle("assistant:settle-turn", (_event, payload) => {
    const sessionId = payload?.sessionId || sessionManager.getActive()?.id;
    if (!sessionId) return { ok: false, error: "NO_SESSION" };

    const runner = runnerPool.get(sessionId);
    if (!runner?.isBusy()) return { ok: false, error: "NOT_BUSY" };

    const settled = runner.settleTurnIfIdle();
    return settled ? { ok: true, sessionId } : { ok: false, error: "NOT_READY", sessionId };
  });

  ipcMain.handle("assistant:interrupt", () => {
    const session = sessionManager.getActive();
    if (!session) return { ok: false, error: "NO_SESSION" };

    const runner = runnerPool.get(session.id);
    const wasRunnerBusy = Boolean(runner?.isBusy());
    const hadTurn = activeTurns.has(session.id) || wasRunnerBusy;
    runner?.interrupt();

    sessionManager.setStatus(session.id, "idle");
    activeTurns.delete(session.id);
    turnOutputs.delete(session.id);

    if (hadTurn && !wasRunnerBusy) {
      sendToRenderer(ctx.mainWindow, "assistant:done", {
        code: null,
        sessionId: session.id,
        interrupted: true,
      });
    }
    return { ok: true };
  });

  warmupActiveRunner(ctx);
}

module.exports = { registerAssistantHandlers };
