"use strict";

const { ipcMain, dialog } = require("electron");
const { ensureSessionRunner, isSessionBusy, withRunnerChange, anyRunnerBusy } = require("./ipc-utils");
const skillManager = require("./skill-manager");
const slashCommands = require("./commands");
const { requireValidLicense } = require("./license-manager");
const {
  listSessionPermissionsPublic,
  resolveSessionPermissionMode,
} = require("./permission-settings");
const { getConversationPageFromSource } = require("./opencode-conversation-source");

const SESSION_SWITCH_WARMUP_DELAY_MS = 150;
const sessionRunnerWarmups = new WeakMap();

function warmupSetFor(ctx) {
  let set = sessionRunnerWarmups.get(ctx);
  if (!set) {
    set = new Set();
    sessionRunnerWarmups.set(ctx, set);
  }
  return set;
}

function scheduleSessionRunnerWarmup(ctx, sessionId) {
  if (!ctx || !sessionId) return false;
  const pending = warmupSetFor(ctx);
  if (pending.has(sessionId)) return false;
  pending.add(sessionId);
  setTimeout(() => {
    Promise.resolve()
      .then(() => {
        if (ctx.sessionManager?.activeSessionId !== sessionId) return null;
        const ensure = ctx.ensureSessionRunner || ensureSessionRunner;
        return ensure(ctx, sessionId, { spawn: false });
      })
      .catch((err) => {
        console.warn("[session] background runner warmup failed:", err?.message || err);
      })
      .finally(() => {
        pending.delete(sessionId);
      });
  }, SESSION_SWITCH_WARMUP_DELAY_MS);
  return true;
}

function switchSessionFast(ctx, sessionId) {
  const { sessionManager, projectManager, runnerPool } = ctx;
  const session = sessionManager.findById(sessionId);
  if (!session) return { ok: false, error: "NOT_FOUND" };

  if (session.projectId !== projectManager.getActive()?.id) {
    projectManager.switchTo(session.projectId);
  }
  sessionManager.switchTo(sessionId);
  const runnerWarmupPending = scheduleSessionRunnerWarmup(ctx, sessionId);

  return {
    ok: true,
    sessionId,
    projectId: session.projectId,
    runnerActive: runnerPool.has(sessionId),
    runnerWarmupPending,
  };
}

function registerSessionHandlers(ctx) {
  const { sessionManager, projectManager, runnerPool } = ctx;

  ipcMain.handle("session:list", () => {
    const project = projectManager.getActive();
    if (!project) {
      return { sessions: [], activeSessionId: null };
    }
    return {
      sessions: sessionManager.listForProject(project.id),
      activeSessionId: sessionManager.activeSessionId,
    };
  });

  ipcMain.handle("session:get-conversation", async (_event, payload) => {
    const sessionId = typeof payload === "string"
      ? payload
      : payload?.sessionId;
    if (!sessionId) return { ok: false, error: "SESSION_ID_REQUIRED", conversation: [] };
    return getConversationPageFromSource(ctx, sessionId, {
      before: Number.isInteger(payload?.before) ? payload.before : undefined,
      limit: Number.isInteger(payload?.limit) ? payload.limit : undefined,
      preferLocal: Boolean(payload?.preferLocal),
      // Passive reads opt OUT of engine boot (default stays true for callers,
      // e.g. the send path, that legitimately need canonical history now).
      allowEngineSpawn: payload?.allowEngineSpawn !== false,
    });
  });

  ipcMain.handle("session:create", (_event, title, projectId) => {
    const pid = projectId || projectManager.getActive()?.id;
    if (!pid) return { ok: false, error: "NO_PROJECT" };
    const session = sessionManager.create(pid, title);
    require("./public-hooks").observePublicHook(ctx.publicHookRuntime, "session.start", {
      sessionId: session.id,
      projectId: pid,
      source: "desktop",
    });
    return { ok: true, session: { id: session.id, title: session.title, projectId: pid } };
  });

  ipcMain.handle("session:switch", (_event, sessionId) => {
    return switchSessionFast(ctx, sessionId);
  });

  ipcMain.handle("session:rename", (_event, sessionId, title) => {
    const trimmed = String(title || "").trim();
    if (!trimmed) return { ok: false, error: "INVALID" };
    if (!sessionManager.rename(sessionId, trimmed)) return { ok: false, error: "NOT_FOUND" };
    return { ok: true };
  });

  ipcMain.handle("session:delete", (_event, sessionId) => {
    const session = sessionManager.findById(sessionId);
    runnerPool.terminateSession(sessionId);
    const result = sessionManager.delete(sessionId);
    if (result !== "OK") return { ok: false, error: result };
    require("./public-hooks").observePublicHook(ctx.publicHookRuntime, "session.end", {
      sessionId,
      projectId: session?.projectId || "",
      reason: "deleted",
    });
    return { ok: true };
  });

  ipcMain.handle("session:archive", (_event, sessionId) => {
    const session = sessionManager.findById(sessionId);
    runnerPool.terminateSession(sessionId);
    sessionManager.archive(sessionId);
    require("./public-hooks").observePublicHook(ctx.publicHookRuntime, "session.end", {
      sessionId,
      projectId: session?.projectId || "",
      reason: "archived",
    });
    return { ok: true };
  });

  ipcMain.handle("session:get-skills", (_event, sessionId) => {
    const sid = sessionId || null;
    if (!sid) return { ok: false, error: "SESSION_ID_REQUIRED" };
    const session = sid ? sessionManager.findById(sid) : null;
    if (!session) return { ok: false, error: "NOT_FOUND" };
    return {
      ok: true,
      sessionId: sid,
      ...skillManager.listSkillsForSessionPublic(session, projectManager.find(session.projectId)?.path || session.workspacePath || ""),
    };
  });

  ipcMain.handle("session:set-skills", (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const sessionId = payload?.sessionId || null;
    if (!sessionId) return { ok: false, error: "SESSION_ID_REQUIRED" };
    const session = sessionId ? sessionManager.findById(sessionId) : null;
    if (!session) return { ok: false, error: "NOT_FOUND" };
    if (isSessionBusy(runnerPool, sessionId)) {
      return { ok: false, error: "BUSY" };
    }
    const normalized = skillManager.normalizeSessionSkillSelection(payload?.enabledSkillIds, projectManager.find(session.projectId)?.path || session.workspacePath || "");
    if (!sessionManager.setEnabledSkillIds(sessionId, normalized)) {
      return { ok: false, error: "NOT_FOUND" };
    }
    const updated = sessionManager.findById(sessionId);
    const project = projectManager.find(updated?.projectId);
    skillManager.writeSessionAgentGuide(sessionId, updated, project?.path || updated.workspacePath || "");
    const runner = runnerPool.get(sessionId);
    if (runner?.isAlive() && !runner.isBusy()) {
      if (!runner.reloadSkills()) runnerPool.terminateSession(sessionId);
    } else {
      runnerPool.terminateSession(sessionId);
    }
    return {
      ok: true,
      sessionId,
      ...skillManager.listSkillsForSessionPublic(updated, project?.path || updated.workspacePath || ""),
    };
  });

  ipcMain.handle("session:get-permission", (_event, sessionId) => {
    const sid = sessionId || null;
    if (!sid) return { ok: false, error: "SESSION_ID_REQUIRED" };
    const session = sid ? sessionManager.findById(sid) : null;
    if (!session) return { ok: false, error: "NOT_FOUND" };
    return {
      ok: true,
      sessionId: sid,
      ...listSessionPermissionsPublic(session),
    };
  });

  // Slash commands available for a session's workspace (for the composer "/" menu).
  ipcMain.handle("commands:list", (_event, sessionId) => {
    const sid = sessionId || null;
    if (!sid) return { ok: false, error: "SESSION_ID_REQUIRED", commands: [] };
    const session = sid ? sessionManager.findById(sid) : null;
    const project = session?.projectId ? projectManager.find(session.projectId) : null;
    const list = slashCommands.loadCommands(project?.path || "");
    return { ok: true, commands: list.map(({ name, description, argHint }) => ({ name, description, argHint })) };
  });

  // Expand a "/name args" composer input into its template (null if not a command).
  ipcMain.handle("commands:expand", (_event, payload) => {
    const sid = payload?.sessionId || null;
    if (!sid) return { ok: false, error: "SESSION_ID_REQUIRED", expanded: null };
    const session = sid ? sessionManager.findById(sid) : null;
    const project = session?.projectId ? projectManager.find(session.projectId) : null;
    const list = slashCommands.loadCommands(project?.path || "");
    return { ok: true, expanded: slashCommands.expandCommand(payload?.input || "", list) };
  });

  // Rewind the conversation to a turn: revert the engine session (files + dropped
  // context) AND truncate Lily's transcript to the same point, in lock-step.
  ipcMain.handle("session:rewind", async (_event, payload) => {
    const sessionId = payload?.sessionId || null;
    const turnId = payload?.turnId;
    if (!sessionId) return { ok: false, error: "SESSION_ID_REQUIRED" };
    const engineMessageId = payload?.engineMessageId || null;
    const session = sessionId ? sessionManager.findById(sessionId) : null;
    if (!session || !turnId) return { ok: false, error: "NOT_FOUND" };
    if (isSessionBusy(runnerPool, sessionId)) return { ok: false, error: "BUSY" };

    // Revert the ENGINE first; only truncate Lily's store if that succeeds, so the
    // two never diverge (a mismatch is the context-corruption class we guard against).
    if (engineMessageId) {
      try {
        ensureSessionRunner(ctx, sessionId, { spawn: true });
        const runner = runnerPool.get(sessionId);
        const reverted = runner ? await runner.revert(engineMessageId) : false;
        if (!reverted) return { ok: false, error: "REWIND_ENGINE_FAILED" };
      } catch (err) {
        return { ok: false, error: "REWIND_ENGINE_FAILED", detail: String(err?.message || err) };
      }
    }
    const removed = sessionManager.deleteMessagesFromTurn(sessionId, turnId);
    // Hand back the truncated transcript so the renderer can resync in lock-step.
    const page = await getConversationPageFromSource(ctx, sessionId, {});
    return { ok: true, sessionId, turnId, removed, conversation: page?.conversation || [] };
  });

  ipcMain.handle("session:set-permission", (_event, payload) => {
    const sessionId = payload?.sessionId || null;
    if (!sessionId) return { ok: false, error: "SESSION_ID_REQUIRED" };
    const session = sessionId ? sessionManager.findById(sessionId) : null;
    if (!session) return { ok: false, error: "NOT_FOUND" };
    if (isSessionBusy(runnerPool, sessionId)) {
      return { ok: false, error: "BUSY" };
    }
    if (!sessionManager.setPermissionMode(sessionId, payload?.modeId ?? null)) {
      return { ok: false, error: "NOT_FOUND" };
    }
    const updated = sessionManager.findById(sessionId);
    const effectiveMode = resolveSessionPermissionMode(updated);
    const runner = runnerPool.get(sessionId);
    if (runner?.isAlive() && !runner.isBusy() && !runner.setPermissionMode(effectiveMode)) {
      runnerPool.terminateSession(sessionId);
    }
    return {
      ok: true,
      sessionId,
      ...listSessionPermissionsPublic(updated),
    };
  });
}

/** Trim the guide measurement to what the settings UI needs: no absolute
 *  paths, and id lists capped so a pathological config cannot bloat the IPC
 *  payload. Returns null rather than throwing. */
function publicGuideBudget() {
  try {
    const measured = skillManager.measureAgentGuideBudget();
    return {
      totalBytes: measured.totalBytes,
      maxBytes: measured.maxBytes,
      share: measured.share,
      indexed: measured.indexed,
      headroomSkills: measured.headroomSkills,
      atRisk: measured.atRisk,
      omittedIds: measured.omittedIds.slice(0, 20),
      omittedCount: measured.omittedIds.length,
      undescribedIds: measured.undescribedIds.slice(0, 20),
      undescribedCount: measured.undescribedIds.length,
    };
  } catch {
    return null;
  }
}

function registerSkillHandlers(ctx) {
  const { runnerPool } = ctx;

  ipcMain.handle("skills:list", () => ({
    ok: true,
    skills: skillManager.listSkillsPublic(),
    // How close this install is to the guide budget. The skill index is what
    // tells the model which skills exist, and past the budget entries are
    // dropped silently, so the number belongs where skills are managed.
    // Strictly informational: a measurement failure must not break the list.
    guideBudget: publicGuideBudget(),
  }));

  ipcMain.handle("skills:set-enabled", (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const id = payload?.id;
    const enabled = Boolean(payload?.enabled);
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => {
      return skillManager.setSkillEnabledWithSessions(id, enabled, ctx.sessionManager);
    }, { refreshState: true, liveEnv: false, reloadSkills: true });
  });

  ipcMain.handle("skills:refresh", () => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    return withRunnerChange(ctx, () => skillManager.refreshSkillsConfig(), { liveEnv: false, reloadSkills: true });
  });

  ipcMain.handle("skills:restore-bundled", (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const id = payload?.id;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => skillManager.restoreBundledSkill(id), { liveEnv: false, reloadSkills: true });
  });

  ipcMain.handle("skills:check-updates", async () => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const licensed = requireValidLicense();
    return skillManager.checkRegistryUpdates({ fetch: licensed.ok });
  });

  ipcMain.handle("skills:install", async (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const id = payload?.id;
    const version = payload?.version;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => skillManager.installFromRegistry(id, version), { liveEnv: false, reloadSkills: true });
  });

  ipcMain.handle("skills:update", async (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const id = payload?.id;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => skillManager.updateFromRegistry(id), { liveEnv: false, reloadSkills: true });
  });

  ipcMain.handle("skills:uninstall", (_event, payload) => {
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const id = payload?.id;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(ctx, () => skillManager.uninstallRemoteSkill(id), { liveEnv: false, reloadSkills: true });
  });

  ipcMain.handle("skills:import-workspace", async () => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;
    const project = ctx.projectManager?.getActive?.();
    if (!project?.id) return { ok: false, error: "NO_PROJECT" };

    const picked = await dialog.showOpenDialog(ctx.mainWindow, {
      title: "导入工作空间技能",
      properties: ["openFile", "openDirectory"],
      filters: [
        { name: "Lily Skill Package", extensions: ["zip"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };

    const { importWorkspaceSkillSource } = require("./workspace-skill-import");
    return withRunnerChange(ctx, async () => {
      const result = await importWorkspaceSkillSource(picked.filePaths[0], {
        restore(skill) {
          return skillManager.restoreWorkspaceSkillDir(skill.dir, skill.manifest, {
            enabled: true,
            projectId: project.id,
          });
        },
      });
      if (result?.ok) skillManager.syncInheritedSessionGuides(ctx.sessionManager);
      return result;
    }, { refreshState: true, liveEnv: false, reloadSkills: true });
  });

  ipcMain.handle("skills:get-preset-guide", () => ({
    ok: true,
    guide: skillManager.getSkillPresetGuideState(),
  }));

  ipcMain.handle("skills:set-preset-guide-status", (_event, payload) => {
    const status = payload?.status;
    return skillManager.setSkillPresetGuideStatus(status);
  });

  ipcMain.handle("skills:apply-preset", async (_event, payload) => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const licensed = requireValidLicense();
    if (!licensed.ok) return licensed;

    const id = payload?.id;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    return withRunnerChange(
      ctx,
      async () => {
        const result = await skillManager.applySkillPreset(id);
        if (result.ok && ctx.sessionManager) {
          skillManager.syncInheritedSessionGuides(ctx.sessionManager);
        }
        return result;
      },
      { refreshState: true, liveEnv: false, reloadSkills: true },
    );
  });
}

module.exports = {
  registerSessionHandlers,
  registerSkillHandlers,
  scheduleSessionRunnerWarmup,
  switchSessionFast,
};
