"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { ipcMain } = require("electron");
const { requireValidLicense } = require("./license-manager");
const { looksLikeScheduledTaskIntent } = require("./scheduled-task-intent");
const {
  buildWebSystemLearningPrompt,
  ensureWebSystemLearningSkillForSession,
  looksLikeWebSystemLearningIntent,
} = require("./web-system-learning-intent");

function resolveTargetSession(sessionManager, requestedId) {
  return requestedId
    ? sessionManager.findById(requestedId)
    : sessionManager.getActive();
}

function attachRouting(result, session) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    sessionId: result.sessionId || session.id,
    projectId: result.projectId || session.projectId || null,
  };
}

function registerAssistantHandlers(ctx) {
  const { sessionManager, projectManager, turnOrchestrator, runnerPool } = ctx;

  ipcMain.handle("assistant:input", async (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const text = typeof payload === "string" ? payload : payload.text;
    const files = typeof payload === "object" && payload.files ? payload.files : [];
    const requestedId =
      typeof payload === "object" && payload?.sessionId ? payload.sessionId : null;

    const session = resolveTargetSession(sessionManager, requestedId);
    if (!session) return { ok: false, error: "NO_SESSION" };

    const displayFiles =
      typeof payload === "object" && Array.isArray(payload.displayFiles)
        ? payload.displayFiles
        : [];

    if (ctx.scheduledTaskManager && looksLikeScheduledTaskIntent(text, files)) {
      const draftResult = await ctx.scheduledTaskManager.parseDraftSmart({
        text,
        sessionId: session.id,
        projectId: session.projectId,
      });
      if (draftResult?.ok) {
        const assistantMessageId = `msg_${crypto.randomUUID()}`;
        sessionManager.pushMessageTo(session.id, "user", text, null, {
          id: `msg_${crypto.randomUUID()}`,
        });
        sessionManager.pushMessageTo(
          session.id,
          "assistant",
          "I understand this as an automated task. Please confirm to create it.",
          null,
          {
            id: assistantMessageId,
            meta: {
              scheduledDraft: {
                status: "pending",
                source: draftResult.source || "model",
                originalText: text,
                draft: draftResult.draft,
                createdAt: new Date().toISOString(),
              },
            },
          },
        );
        const page = sessionManager.getConversationPage(session.id, { limit: 80 });
        return {
          ok: true,
          scheduledDraft: true,
          sessionId: session.id,
          projectId: session.projectId || null,
          assistantMessageId,
          conversation: page.conversation,
        };
      }
    }

    const webLearningIntent = looksLikeWebSystemLearningIntent(text, files);
    const engineText = webLearningIntent ? buildWebSystemLearningPrompt(text) : null;
    let reloadSkillsBeforeStart = false;
    if (webLearningIntent) {
      const ensured = await ensureWebSystemLearningSkillForSession(ctx, session.id);
      if (!ensured.ok) {
        return {
          ok: false,
          error: ensured.error,
          detail: "Web system learning skill is not available. Please refresh the skill catalog and try again.",
        };
      }
      reloadSkillsBeforeStart = Boolean(ensured.needsReloadBeforeNextTurn);
    }

    const result = await turnOrchestrator.sendUserMessage(session.id, text, files, {
      recordUser: true,
      spawnEngine: true,
      displayFiles,
      engineText,
      reloadSkillsBeforeStart,
    });
    return attachRouting(result, session);
  });

  ipcMain.handle("assistant:interrupt-and-send", async (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const text = typeof payload === "string" ? payload : payload.text;
    const files = typeof payload === "object" && payload.files ? payload.files : [];
    const requestedId =
      typeof payload === "object" && payload?.sessionId ? payload.sessionId : null;

    const session = resolveTargetSession(sessionManager, requestedId);
    if (!session) return { ok: false, error: "NO_SESSION" };

    const displayFiles =
      typeof payload === "object" && Array.isArray(payload.displayFiles)
        ? payload.displayFiles
        : [];

    const webLearningIntent = looksLikeWebSystemLearningIntent(text, files);
    const engineText = webLearningIntent ? buildWebSystemLearningPrompt(text) : null;
    let reloadSkillsBeforeStart = false;
    if (webLearningIntent) {
      const ensured = await ensureWebSystemLearningSkillForSession(ctx, session.id);
      if (!ensured.ok) {
        return {
          ok: false,
          error: ensured.error,
          detail: "Web system learning skill is not available. Please refresh the skill catalog and try again.",
        };
      }
      reloadSkillsBeforeStart = Boolean(ensured.needsReloadBeforeNextTurn);
    }

    const result = await turnOrchestrator.interruptAndSend(session.id, text, files, {
      displayFiles,
      engineText,
      reloadSkillsBeforeStart,
    });
    return attachRouting(result, session);
  });

  ipcMain.handle("assistant:retry", async (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const sessionId = payload?.sessionId || sessionManager.getActive()?.id;
    const session = sessionId ? sessionManager.findById(sessionId) : null;
    if (!session) return { ok: false, error: "NO_SESSION" };

    const lastUser = sessionManager.getLastUserMessage(session.id);
    if (!lastUser) return { ok: false, error: "NO_USER_MESSAGE" };

    const lastMsg = sessionManager.getLastMessage(session.id);
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
          ? `Attachments no longer available: ${missing.join(", ")}`
          : "The original message contained attachments, but the paths are no longer accessible. Please re-add the attachments and resend.",
      };
    }

    return await turnOrchestrator.retryLastMessage(session.id);
  });

  // L1 learned conventions: "记住：…" saves a per-project rule app-side and
  // refreshes the session guide so the running engine picks it up.
  ipcMain.handle("assistant:remember-convention", (_event, payload) => {
    const sessionId = payload?.sessionId || sessionManager.getActive()?.id;
    const text = String(payload?.text || "").trim();
    if (!sessionId || !text) return { ok: false, error: "INVALID_PAYLOAD" };
    const session = sessionManager.findById(sessionId);
    if (!session) return { ok: false, error: "NOT_FOUND" };
    const { appendLearnedConvention } = require("./learned-context");
    appendLearnedConvention(session.projectId, text);
    const skillManager = require("./skill-manager");
    const project = projectManager.find(session.projectId);
    skillManager.writeSessionAgentGuide(sessionId, session, project?.path || "");
    return { ok: true };
  });

  ipcMain.handle("assistant:permission-response", (_event, payload) => {
    const sessionId = payload?.sessionId || sessionManager.getActive()?.id;
    const requestId = payload?.requestId;
    if (!sessionId || !requestId) {
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    return turnOrchestrator.respondPermission(sessionId, requestId, {
      allow: Boolean(payload.allow),
      message: typeof payload.message === "string" ? payload.message : undefined,
      remember: Boolean(payload.remember),
    });
  });

  ipcMain.handle("assistant:question-response", (_event, payload) => {
    const sessionId = payload?.sessionId || sessionManager.getActive()?.id;
    const requestId = payload?.requestId;
    if (!sessionId || !requestId) {
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    return turnOrchestrator.respondUserQuestion(sessionId, requestId, {
      answers: payload.answers,
      response: payload.response,
    });
  });

  ipcMain.handle("assistant:hook-response", (_event, payload) => {
    const sessionId = payload?.sessionId || sessionManager.getActive()?.id;
    const requestId = payload?.requestId;
    if (!sessionId || !requestId) {
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    return turnOrchestrator.respondHook(sessionId, requestId, {
      allow: Boolean(payload.allow),
      message: typeof payload.message === "string" ? payload.message : undefined,
      updatedInput: payload.updatedInput || undefined,
    });
  });

  ipcMain.handle("assistant:runtime-snapshot", (_event, payload) => {
    const sessionId = payload?.sessionId || sessionManager.getActive()?.id;
    if (!sessionId) return { ok: false, error: "NO_SESSION" };
    return turnOrchestrator.snapshot(sessionId);
  });

  ipcMain.handle("assistant:engine-diagnostics", (_event, payload) => {
    const session = resolveTargetSession(sessionManager, payload?.sessionId || null);
    if (!session) return { ok: false, error: "NO_SESSION" };
    return {
      ok: true,
      sessionId: session.id,
      projectId: session.projectId || null,
      diagnostics: runnerPool?.diagnostics?.(session.id) || null,
    };
  });

  ipcMain.handle("assistant:interrupt", async (_event, payload) => {
    const requestedId = payload?.sessionId || null;
    const session = requestedId
      ? sessionManager.findById(requestedId)
      : sessionManager.getActive();
    if (!session) return { ok: false, error: "NO_SESSION" };

    return turnOrchestrator.interrupt(session.id);
  });

  ipcMain.handle("assistant:cancel-queued-message", (_event, payload) => {
    const sessionId = payload?.sessionId || sessionManager.getActive()?.id;
    const itemId = String(payload?.itemId || payload?.id || "");
    if (!sessionId || !itemId) {
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const session = sessionManager.findById(sessionId);
    if (!session) return { ok: false, error: "NO_SESSION" };

    return turnOrchestrator.cancelQueuedMessage(sessionId, itemId);
  });
}

module.exports = { registerAssistantHandlers };
