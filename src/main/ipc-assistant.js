"use strict";
const fs = require("node:fs");
const { ipcMain } = require("electron");
const { requireValidLicenseFresh } = require("./license-manager");
const { looksLikeScheduledTaskIntent } = require("./scheduled-task-intent");
const { ensureWebSystemLearningSkillForSession } = require("./web-system-learning-intent");
const { ensureRoutingAvailable, resolveEngineRouting } = require("./character-worlds/assistant-routing");
const { resolveCharacterWorldsAdjustment } = require("./character-worlds/adjustment-context");
function resolveTargetSession(sessionManager, requestedId) {
  if (!requestedId) return null;
  return sessionManager.findById(requestedId);
}
function attachRouting(result, session) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    sessionId: result.sessionId || session.id,
    projectId: result.projectId || session.projectId || null,
  };
}
function refreshSessionGuide(projectManager, session) {
  const skillManager = require("./skill-manager");
  const project = projectManager?.find?.(session.projectId);
  skillManager.writeSessionAgentGuide(session.id, session, project?.path || "");
}

function registerAssistantHandlers(ctx) {
  const { sessionManager, projectManager, turnOrchestrator, runnerPool } = ctx;

  ipcMain.handle("assistant:input", async (_event, payload) => {
    const licensed = await requireValidLicenseFresh();
    if (!licensed.ok) return licensed;

    const text = typeof payload === "string" ? payload : payload.text;
    const files = typeof payload === "object" && payload.files ? payload.files : [];
    const requestedId =
      typeof payload === "object" && payload?.sessionId ? payload.sessionId : null;

    if (!requestedId) return { ok: false, error: "SESSION_ID_REQUIRED" };
    const session = resolveTargetSession(sessionManager, requestedId);
    if (!session) return { ok: false, error: "NO_SESSION" };

    const displayFiles =
      typeof payload === "object" && Array.isArray(payload.displayFiles)
        ? payload.displayFiles
        : [];

    let userEchoed = false;
    if (ctx.scheduledTaskManager && looksLikeScheduledTaskIntent(text, files)) {
      // Show the user's message NOW — parseDraftSmart is a model call (seconds) and
      // must not delay the message appearing. Reuse the echoed turnId so the card
      // belongs to the same turn; downstream uses recordUser:false to avoid a dup.
      const echoTurnId = turnOrchestrator.echoUserMessage(session.id, text, files, displayFiles);
      userEchoed = true;
      const draftResult = await ctx.scheduledTaskManager.parseDraftSmart({
        text,
        sessionId: session.id,
        projectId: session.projectId,
      });
      if (draftResult?.ok) {
        const scheduledDraft = {
          status: "pending",
          source: draftResult.source || "model",
          originalText: text,
          draft: draftResult.draft,
          createdAt: new Date().toISOString(),
        };
        const result = await turnOrchestrator.completeLocalAssistantTurn(session.id, text, files, {
          displayFiles,
          assistant: "I understand this as an automated task. Please confirm to create it.",
          scheduledDraft,
          recordUser: false,
          turnId: echoTurnId || undefined,
        });
        return {
          ...attachRouting(result, session),
          scheduledDraft: true,
        };
      }
      // Recognized as a scheduled task but the schedule couldn't be parsed — the
      // user message is already shown; fall through to the normal engine WITHOUT
      // re-committing it (recordUser:false below).
    }

    const { engineText, requiredSuccessfulTools, webLearningIntent } = resolveEngineRouting(
      text, files, payload?.characterAuthoringKind,
      resolveCharacterWorldsAdjustment(ctx, session, payload?.characterWorldsAdjustmentHandle),
    );
    const routingAvailability = await ensureRoutingAvailable(ctx, { requiredSuccessfulTools });
    if (!routingAvailability.ok) return attachRouting(routingAvailability, session);
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
      recordUser: !userEchoed,
      spawnEngine: true,
      displayFiles,
      engineText,
      requiredSuccessfulTools,
      reloadSkillsBeforeStart,
      modelSelection: payload?.modelSelection || null,
    });
    return attachRouting(result, session);
  });

  ipcMain.handle("assistant:interrupt-and-send", async (_event, payload) => {
    const licensed = await requireValidLicenseFresh();
    if (!licensed.ok) return licensed;

    const text = typeof payload === "string" ? payload : payload.text;
    const files = typeof payload === "object" && payload.files ? payload.files : [];
    const requestedId =
      typeof payload === "object" && payload?.sessionId ? payload.sessionId : null;

    if (!requestedId) return { ok: false, error: "SESSION_ID_REQUIRED" };
    const session = resolveTargetSession(sessionManager, requestedId);
    if (!session) return { ok: false, error: "NO_SESSION" };

    const displayFiles =
      typeof payload === "object" && Array.isArray(payload.displayFiles)
        ? payload.displayFiles
        : [];

    const { engineText, requiredSuccessfulTools, webLearningIntent } = resolveEngineRouting(
      text, files, payload?.characterAuthoringKind,
      resolveCharacterWorldsAdjustment(ctx, session, payload?.characterWorldsAdjustmentHandle),
    );
    const routingAvailability = await ensureRoutingAvailable(ctx, { requiredSuccessfulTools });
    if (!routingAvailability.ok) return attachRouting(routingAvailability, session);
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
      requiredSuccessfulTools,
      reloadSkillsBeforeStart,
      modelSelection: payload?.modelSelection || null,
    });
    return attachRouting(result, session);
  });

  // Steer ("插话"): inject into the running turn without interrupting it. Falls back
  // to queue inside the orchestrator when steering isn't possible (flag off, not
  // busy, engine rejects) — so the worst case equals today's queue behavior.
  ipcMain.handle("assistant:steer", async (_event, payload) => {
    const licensed = await requireValidLicenseFresh();
    if (!licensed.ok) return licensed;

    const text = typeof payload === "string" ? payload : payload.text;
    const files = typeof payload === "object" && payload.files ? payload.files : [];
    const requestedId =
      typeof payload === "object" && payload?.sessionId ? payload.sessionId : null;

    if (!requestedId) return { ok: false, error: "SESSION_ID_REQUIRED" };
    const session = resolveTargetSession(sessionManager, requestedId);
    if (!session) return { ok: false, error: "NO_SESSION" };

    const displayFiles =
      typeof payload === "object" && Array.isArray(payload.displayFiles)
        ? payload.displayFiles
        : [];

    const routing = resolveEngineRouting(text, files, payload?.characterAuthoringKind,
      resolveCharacterWorldsAdjustment(ctx, session, payload?.characterWorldsAdjustmentHandle));
    if (routing.requiredSuccessfulTools.length) {
      const routingAvailability = await ensureRoutingAvailable(ctx, routing);
      if (!routingAvailability.ok) return attachRouting(routingAvailability, session);
      const result = await turnOrchestrator.sendUserMessage(session.id, text, files, {
        displayFiles,
        engineText: routing.engineText,
        requiredSuccessfulTools: routing.requiredSuccessfulTools,
        modelSelection: payload?.modelSelection || null,
      });
      return attachRouting(result, session);
    }

    const result = await turnOrchestrator.sendUserMessage(session.id, text, files, {
      mode: "steer",
      displayFiles,
      modelSelection: payload?.modelSelection || null,
    });
    return attachRouting(result, session);
  });

  // Renderer-visible feature flags. Steer is on by default; LILY_ENABLE_STEER=0 is the
  // instant kill-switch that also hides the "插话" option from the busy dialog.
  ipcMain.handle("assistant:feature-flags", () => ({
    steer: process.env.LILY_ENABLE_STEER !== "0",
  }));

  ipcMain.handle("assistant:retry", async (_event, payload) => {
    const licensed = await requireValidLicenseFresh();
    if (!licensed.ok) return licensed;

    const sessionId = payload?.sessionId || null;
    if (!sessionId) return { ok: false, error: "SESSION_ID_REQUIRED" };
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

    const routing = resolveEngineRouting(lastUser.content, files, payload?.characterAuthoringKind,
      resolveCharacterWorldsAdjustment(ctx, session, payload?.characterWorldsAdjustmentHandle));
    const routingAvailability = await ensureRoutingAvailable(ctx, routing);
    if (!routingAvailability.ok) return attachRouting(routingAvailability, session);
    return await turnOrchestrator.retryLastMessage(session.id, {
      engineText: routing.engineText,
      requiredSuccessfulTools: routing.requiredSuccessfulTools,
    });
  });

  // L1 learned conventions: "记住：…" saves a per-project rule app-side and
  // refreshes the session guide so the running engine picks it up.
  ipcMain.handle("assistant:remember-convention", (_event, payload) => {
    const sessionId = payload?.sessionId || null;
    const text = String(payload?.text || "").trim();
    if (!sessionId) return { ok: false, error: "SESSION_ID_REQUIRED" };
    if (!text) return { ok: false, error: "INVALID_PAYLOAD" };
    const session = sessionManager.findById(sessionId);
    if (!session) return { ok: false, error: "NOT_FOUND" };
    if (!session.projectId) return { ok: false, error: "NO_PROJECT" };
    const { appendLearnedConvention } = require("./learned-context");
    const entry = appendLearnedConvention(session.projectId, text);
    if (!entry) return { ok: false, error: "INVALID_PAYLOAD" };
    refreshSessionGuide(projectManager, session);
    return { ok: true };
  });

  ipcMain.handle("assistant:memory:list", (_event, payload) => {
    const session = resolveTargetSession(sessionManager, payload?.sessionId || null);
    if (!session) return { ok: false, error: "NO_SESSION" };
    const { listLearnedConventions } = require("./learned-context");
    const { listMemoryProposals } = require("./auto-memory-proposals");
    const { MEMORY_CATEGORIES, readMemoryPreferences } = require("./memory-preferences");
    return {
      ok: true,
      sessionId: session.id,
      projectId: session.projectId || null,
      learned: listLearnedConventions(session.projectId),
      proposals: listMemoryProposals(session.projectId, {
        includeDismissed: Boolean(payload?.includeDismissed),
      }),
      preferences: readMemoryPreferences(session.projectId),
      categories: MEMORY_CATEGORIES,
    };
  });

  ipcMain.handle("assistant:memory:set-category-enabled", (_event, payload) => {
    const session = resolveTargetSession(sessionManager, payload?.sessionId || null);
    const kind = String(payload?.kind || "");
    if (!session) return { ok: false, error: "NO_SESSION" };
    if (!kind) return { ok: false, error: "INVALID_PAYLOAD" };
    const { setMemoryCategoryEnabled } = require("./memory-preferences");
    const preferences = setMemoryCategoryEnabled(session.projectId, kind, Boolean(payload?.enabled));
    if (!preferences) return { ok: false, error: "INVALID_KIND" };
    refreshSessionGuide(projectManager, session);
    return {
      ok: true,
      sessionId: session.id,
      projectId: session.projectId || null,
      preferences,
    };
  });

  ipcMain.handle("assistant:memory:export", (_event, payload) => {
    const session = resolveTargetSession(sessionManager, payload?.sessionId || null);
    if (!session) return { ok: false, error: "NO_SESSION" };
    const { listLearnedConventions } = require("./learned-context");
    const { listMemoryProposals } = require("./auto-memory-proposals");
    const { readSessionSummary } = require("./session-memory");
    return {
      ok: true,
      exportedAt: new Date().toISOString(),
      sessionId: session.id,
      projectId: session.projectId || null,
      memory: {
        learned: listLearnedConventions(session.projectId),
        proposals: listMemoryProposals(session.projectId, { includeDismissed: true }),
        sessionSummary: readSessionSummary(session.id) || null,
      },
    };
  });

  ipcMain.handle("assistant:memory:remove-learned", (_event, payload) => {
    const session = resolveTargetSession(sessionManager, payload?.sessionId || null);
    const key = String(payload?.key || "");
    if (!session) return { ok: false, error: "NO_SESSION" };
    if (!key) return { ok: false, error: "INVALID_PAYLOAD" };
    const { removeLearnedConvention } = require("./learned-context");
    const removed = removeLearnedConvention(session.projectId, key);
    if (!removed) return { ok: false, error: "NOT_FOUND" };
    refreshSessionGuide(projectManager, session);
    return {
      ok: true,
      sessionId: session.id,
      projectId: session.projectId || null,
      removed,
    };
  });

  ipcMain.handle("assistant:memory:clear-learned", (_event, payload) => {
    const session = resolveTargetSession(sessionManager, payload?.sessionId || null);
    if (!session) return { ok: false, error: "NO_SESSION" };
    const { clearLearnedConventions } = require("./learned-context");
    clearLearnedConventions(session.projectId);
    refreshSessionGuide(projectManager, session);
    return {
      ok: true,
      sessionId: session.id,
      projectId: session.projectId || null,
    };
  });

  ipcMain.handle("assistant:memory-proposals:list", (_event, payload) => {
    const session = resolveTargetSession(sessionManager, payload?.sessionId || null);
    if (!session) return { ok: false, error: "NO_SESSION" };
    const { listMemoryProposals } = require("./auto-memory-proposals");
    return {
      ok: true,
      sessionId: session.id,
      projectId: session.projectId || null,
      proposals: listMemoryProposals(session.projectId, {
        includeDismissed: Boolean(payload?.includeDismissed),
      }),
    };
  });

  ipcMain.handle("assistant:memory-proposals:approve", (_event, payload) => {
    const session = resolveTargetSession(sessionManager, payload?.sessionId || null);
    const key = String(payload?.key || "");
    if (!session) return { ok: false, error: "NO_SESSION" };
    if (!key) return { ok: false, error: "INVALID_PAYLOAD" };
    const { approveMemoryProposal } = require("./auto-memory-proposals");
    const proposal = approveMemoryProposal(session.projectId, key, { approvedBy: "user" });
    if (!proposal) return { ok: false, error: "NOT_FOUND" };
    refreshSessionGuide(projectManager, session);
    return {
      ok: true,
      sessionId: session.id,
      projectId: session.projectId || null,
      proposal,
    };
  });

  ipcMain.handle("assistant:memory-proposals:dismiss", (_event, payload) => {
    const session = resolveTargetSession(sessionManager, payload?.sessionId || null);
    const key = String(payload?.key || "");
    if (!session) return { ok: false, error: "NO_SESSION" };
    if (!key) return { ok: false, error: "INVALID_PAYLOAD" };
    const { dismissMemoryProposal } = require("./auto-memory-proposals");
    const proposal = dismissMemoryProposal(session.projectId, key, { dismissedBy: "user" });
    if (!proposal) return { ok: false, error: "NOT_FOUND" };
    return {
      ok: true,
      sessionId: session.id,
      projectId: session.projectId || null,
      proposal,
    };
  });

  ipcMain.handle("assistant:permission-response", (_event, payload) => {
    const sessionId = payload?.sessionId || null;
    const requestId = payload?.requestId;
    if (!sessionId) return { ok: false, error: "SESSION_ID_REQUIRED" };
    if (!requestId) {
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    return turnOrchestrator.respondPermission(sessionId, requestId, {
      allow: Boolean(payload.allow),
      message: typeof payload.message === "string" ? payload.message : undefined,
      remember: Boolean(payload.remember),
    });
  });

  ipcMain.handle("assistant:question-response", (_event, payload) => {
    const sessionId = payload?.sessionId || null;
    const requestId = payload?.requestId;
    if (!sessionId) return { ok: false, error: "SESSION_ID_REQUIRED" };
    if (!requestId) {
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    return turnOrchestrator.respondUserQuestion(sessionId, requestId, {
      answers: payload.answers,
      response: payload.response,
    });
  });

  ipcMain.handle("assistant:hook-response", (_event, payload) => {
    const sessionId = payload?.sessionId || null;
    const requestId = payload?.requestId;
    if (!sessionId) return { ok: false, error: "SESSION_ID_REQUIRED" };
    if (!requestId) {
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    return turnOrchestrator.respondHook(sessionId, requestId, {
      allow: Boolean(payload.allow),
      message: typeof payload.message === "string" ? payload.message : undefined,
      updatedInput: payload.updatedInput || undefined,
    });
  });

  ipcMain.handle("assistant:runtime-snapshot", (_event, payload) => {
    const sessionId = payload?.sessionId || null;
    if (!sessionId) return { ok: false, error: "SESSION_ID_REQUIRED" };
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
    if (!requestedId) return { ok: false, error: "SESSION_ID_REQUIRED" };
    const session = sessionManager.findById(requestedId);
    if (!session) return { ok: false, error: "NO_SESSION" };

    return turnOrchestrator.interrupt(session.id);
  });

  ipcMain.handle("assistant:cancel-queued-message", (_event, payload) => {
    const sessionId = payload?.sessionId || null;
    const itemId = String(payload?.itemId || payload?.id || "");
    if (!sessionId) return { ok: false, error: "SESSION_ID_REQUIRED" };
    if (!itemId) {
      return { ok: false, error: "INVALID_PAYLOAD" };
    }

    const session = sessionManager.findById(sessionId);
    if (!session) return { ok: false, error: "NO_SESSION" };

    return turnOrchestrator.cancelQueuedMessage(sessionId, itemId);
  });
}

module.exports = { ensureRoutingAvailable, registerAssistantHandlers, resolveEngineRouting };
