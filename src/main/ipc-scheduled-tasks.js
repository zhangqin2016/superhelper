"use strict";

const { ipcMain } = require("electron");

function activeScope(ctx, payload = {}) {
  const sessionId = String(payload.sessionId || ctx.sessionManager?.activeSessionId || "").trim();
  const session = sessionId ? ctx.sessionManager?.findById?.(sessionId) : null;
  const projectId = String(payload.projectId || session?.projectId || ctx.projectManager?.activeProjectId || "").trim();
  return { sessionId, projectId };
}

function registerScheduledTaskHandlers(ctx) {
  ipcMain.handle("scheduled-tasks:list", (_event, payload = {}) => {
    const scope = activeScope(ctx, payload);
    return ctx.scheduledTaskManager.list({
      sessionId: payload.sessionId === null ? "" : scope.sessionId,
      projectId: payload.projectId === null ? "" : scope.projectId,
    });
  });

  ipcMain.handle("scheduled-tasks:parse-draft", async (_event, payload = {}) => {
    const scope = activeScope(ctx, payload);
    if (!scope.projectId) return { ok: false, error: "NO_PROJECT" };
    if (!scope.sessionId) return { ok: false, error: "NO_SESSION" };
    return ctx.scheduledTaskManager.parseDraftSmart({
      text: payload.text,
      sessionId: scope.sessionId,
      projectId: scope.projectId,
    });
  });

  ipcMain.handle("scheduled-tasks:create", (_event, payload = {}) => {
    const scope = activeScope(ctx, payload);
    return ctx.scheduledTaskManager.create({
      ...payload,
      sessionId: scope.sessionId,
      projectId: scope.projectId,
    });
  });

  ipcMain.handle("scheduled-tasks:create-from-draft-message", (_event, payload = {}) => {
    const scope = activeScope(ctx, payload);
    const messageId = String(payload.messageId || "").trim();
    if (!scope.projectId) return { ok: false, error: "NO_PROJECT" };
    if (!scope.sessionId) return { ok: false, error: "NO_SESSION" };
    if (!messageId) return { ok: false, error: "MISSING_MESSAGE" };

    const message = ctx.sessionManager.findMessage(scope.sessionId, messageId);
    const scheduledDraft = message?.meta?.scheduledDraft;
    if (!scheduledDraft?.draft) return { ok: false, error: "DRAFT_NOT_FOUND" };
    if (scheduledDraft.status === "created" && scheduledDraft.taskId) {
      const page = ctx.sessionManager.getConversationPage(scope.sessionId, { limit: 80 });
      return {
        ok: true,
        alreadyCreated: true,
        task: scheduledDraft.task || { id: scheduledDraft.taskId },
        conversation: page.conversation,
      };
    }

    const result = ctx.scheduledTaskManager.create({
      ...scheduledDraft.draft,
      sessionId: scope.sessionId,
      projectId: scope.projectId,
    });
    if (!result?.ok) return result;

    ctx.sessionManager.updateMessageMeta(scope.sessionId, messageId, (meta) => ({
      ...meta,
      scheduledDraft: {
        ...(meta.scheduledDraft || scheduledDraft),
        status: "created",
        taskId: result.task.id,
        task: {
          id: result.task.id,
          title: result.task.title,
          scheduleText: result.task.scheduleText,
          nextRunAt: result.task.nextRunAt,
        },
        updatedAt: new Date().toISOString(),
      },
    }));
    const page = ctx.sessionManager.getConversationPage(scope.sessionId, { limit: 80 });
    return { ok: true, task: result.task, conversation: page.conversation };
  });

  ipcMain.handle("scheduled-tasks:set-enabled", (_event, payload = {}) =>
    ctx.scheduledTaskManager.setEnabled(payload.taskId, payload.enabled),
  );

  ipcMain.handle("scheduled-tasks:remove", (_event, payload = {}) =>
    ctx.scheduledTaskManager.remove(payload.taskId),
  );

  ipcMain.handle("scheduled-tasks:run-now", (_event, payload = {}) =>
    ctx.scheduledTaskManager.runNow(payload.taskId),
  );
}

module.exports = { registerScheduledTaskHandlers };
