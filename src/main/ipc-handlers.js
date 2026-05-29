"use strict";

const fs = require("node:fs");
const { ipcMain, dialog, shell } = require("electron");
const FileStagingManager = require("./file-staging-manager");
const { listPresetsPublic, setActivePreset } = require("./model-presets");
const { resolveAgentCommand } = require("./agent-command");
const { sanitizeError, appendTextSegment } = require("./agent-runner");
const { notifySessionFinished } = require("./background-notify");
const { fileStagingDir } = require("./config");
const skillManager = require("./skill-manager");
const { resolveRuntimeIconDataUrl } = require("./app-icon");

function sendToRenderer(window, channel, payload) {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

/** @type {Map<string, string>} */
const turnOutputs = new Map();

/** Sessions with an in-flight assistant turn (guards duplicate done/error). */
const activeTurns = new Set();

function anyRunnerBusy(runnerPool) {
  for (const sessionId of runnerPool.getSessionIds()) {
    const runner = runnerPool.get(sessionId);
    if (runner?.isBusy()) return true;
  }
  return false;
}

function getRunningSessionIds(runnerPool, sessionManager) {
  const ids = new Set(activeTurns);
  for (const sessionId of runnerPool.getSessionIds()) {
    if (runnerPool.get(sessionId)?.isBusy()) ids.add(sessionId);
  }
  for (const list of Object.values(sessionManager.sessions)) {
    for (const session of list) {
      if (session.status === "running") ids.add(session.id);
    }
  }
  return [...ids];
}

function resolveProjectForSession(projectManager, session) {
  if (!session) return null;
  const project = projectManager.find(session.projectId);
  if (project) return project;
  return null;
}

function diagnoseSendBlocker(ctx, sessionId) {
  const cliPath = resolveAgentCommand();
  if (!cliPath) {
    return {
      error: "NO_CLI",
      detail: "内置助手引擎未安装。请完全退出应用后重新打开。",
    };
  }
  if (!fs.existsSync(cliPath)) {
    return {
      error: "NO_CLI",
      detail: `引擎文件不存在：${cliPath}`,
    };
  }

  const { sessionManager, projectManager } = ctx;
  const session =
    sessionManager.findById(sessionId) || sessionManager.getActive();
  if (!session) {
    return { error: "NO_SESSION", detail: "请先创建或选择一个对话。" };
  }

  const project = resolveProjectForSession(projectManager, session);
  if (!project) {
    return { error: "NO_PROJECT", detail: "对话所属的文件夹已不存在，请重新添加文件夹。" };
  }
  if (!fs.existsSync(project.path)) {
    return {
      error: "INVALID_WORKDIR",
      detail: `工作目录不存在：${project.path}`,
    };
  }

  return null;
}

function wireRunner(ctx, runner) {
  if (runner._ipcWired) return;
  runner._ipcWired = true;

  const sessionId = runner.sessionId;
  const { sessionManager } = ctx;

  runner.on("chunk", (text) => {
    const prev = turnOutputs.get(sessionId) || "";
    const next = appendTextSegment(prev, text);
    turnOutputs.set(sessionId, next);
    sendToRenderer(ctx.mainWindow, "assistant:chunk", { sessionId, text });
  });

  runner.on("stderr", (text) => {
    console.error(`[agent stderr ${sessionId}]`, text);
  });

  runner.on("tool-using", (data) => {
    sendToRenderer(ctx.mainWindow, "assistant:tool", { sessionId, ...data });
  });

  runner.on("tool-done", (data) => {
    sendToRenderer(ctx.mainWindow, "assistant:tool-done", { sessionId, ...data });
  });

  runner.on("status", (state) => {
    if (state === "thinking") {
      sessionManager.setStatus(sessionId, "running");
    }
    sendToRenderer(ctx.mainWindow, "assistant:status", { state, sessionId });
  });

  runner.on("agent-resume-id", (agentResumeId) => {
    sessionManager.setAgentResumeId(sessionId, agentResumeId);
  });

  runner.on("done", ({ code, output, interrupted }) => {
    if (!activeTurns.has(sessionId)) return;
    activeTurns.delete(sessionId);

    const finalOutput = (output || turnOutputs.get(sessionId) || "").trim();
    turnOutputs.delete(sessionId);

    if (finalOutput) {
      sessionManager.pushMessageTo(sessionId, "assistant", finalOutput);
    } else if (!interrupted && code !== 0 && code !== null) {
      sessionManager.pushMessageTo(
        sessionId,
        "assistant",
        "这次没有收到有效回复，请稍后重试。",
      );
    }

    sessionManager.setStatus(sessionId, "idle");
    sendToRenderer(ctx.mainWindow, "assistant:done", { code, sessionId });

    const session = sessionManager.findById(sessionId);
    const wasFocused = ctx.mainWindow?.isFocused?.() ?? true;
    if (!wasFocused) {
      notifySessionFinished(ctx.mainWindow, {
        sessionId,
        sessionTitle: session?.title,
        ok: Boolean(finalOutput),
        body: finalOutput,
      });
    }
  });

  runner.on("error", (message) => {
    if (!activeTurns.has(sessionId)) return;
    activeTurns.delete(sessionId);

    turnOutputs.delete(sessionId);
    const friendly =
      message === "BUSY"
        ? "上一条消息还在处理中，请稍后再试。"
        : sanitizeError(String(message));
    sessionManager.pushMessageTo(sessionId, "assistant", friendly);
    sessionManager.setStatus(sessionId, "idle");
    sendToRenderer(ctx.mainWindow, "assistant:error", {
      sessionId,
      message: friendly,
    });
  });
}

/**
 * @returns {{ runner: import('./agent-session').AgentSession | null, error?: string, detail?: string }}
 */
function ensureSessionRunner(ctx, sessionId) {
  const { sessionManager, projectManager, runnerPool } = ctx;
  const session = sessionManager.findById(sessionId);
  if (!session) {
    return {
      runner: null,
      error: "NO_SESSION",
      detail: "对话不存在或已删除，请重新选择或新建对话。",
    };
  }

  const project = resolveProjectForSession(projectManager, session);
  if (!project) {
    return {
      runner: null,
      error: "NO_PROJECT",
      detail: "对话所属的文件夹已不存在，请重新添加文件夹。",
    };
  }

  const cliPath = resolveAgentCommand();
  if (!cliPath) {
    return {
      runner: null,
      error: "NO_CLI",
      detail: "内置助手引擎未安装。请完全退出应用后重新打开。",
    };
  }
  if (!fs.existsSync(cliPath)) {
    return {
      runner: null,
      error: "NO_CLI",
      detail: `引擎文件不存在：${cliPath}`,
    };
  }
  if (!fs.existsSync(project.path)) {
    return {
      runner: null,
      error: "INVALID_WORKDIR",
      detail: `工作目录不存在：${project.path}`,
    };
  }

  const stagingDir = fileStagingDir();
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
  } catch (err) {
    console.warn("[runner] could not create staging dir:", err.message);
  }
  const extra = {
    disallowedTools: skillManager.getDisallowedTools(),
    stagingDir,
    resumeSessionId: session.agentResumeId || null,
  };

  try {
    const runner = runnerPool.ensure(sessionId, project.path, extra);
    wireRunner(ctx, runner);
    return { runner };
  } catch (err) {
    console.error("[runner]", sessionId, err.message);
    if (err.stack) console.error(err.stack);
    const detail =
      err.message && !/^(RUNNER_|AGENT_|NO_)/.test(err.message)
        ? err.message
        : sanitizeError(err.message);
    return { runner: null, error: "RUNNER_ERROR", detail };
  }
}

function warmupActiveRunner(ctx) {
  const session = ctx.sessionManager.getActive();
  if (!session) return;
  const result = ensureSessionRunner(ctx, session.id);
  if (!result.runner) {
    console.error("[runner] warmup failed:", result.error, result.detail);
  }
}

function buildInputLine(text, files = []) {
  const parts = [String(text || "").trim()];
  for (const f of files) {
    if (f.path) parts.push(f.path);
  }
  return parts.filter(Boolean).join(" ");
}

function registerAll(ctx) {
  const {
    mainWindow, projectManager, sessionManager,
    stagingManager, runnerPool,
  } = ctx;

  ipcMain.handle("app:get-icon-url", () => resolveRuntimeIconDataUrl());

  // --- Files ---------------------------------------------------------------

  ipcMain.handle("files:pick", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择文件",
      properties: ["openFile", "multiSelections"],
      filters: FileStagingManager.getFileFilters(),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const staged = [];
    const errors = [];
    for (const filePath of result.filePaths) {
      try {
        const meta = stagingManager.stageFromPath(filePath);
        staged.push(meta);
      } catch (err) {
        errors.push({ path: filePath, error: err.message });
      }
    }
    return { ok: true, files: staged, errors };
  });

  ipcMain.handle("files:stage", (_event, filePath) => {
    try {
      const meta = stagingManager.stageFromPath(filePath);
      return { ok: true, file: meta };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("files:paste", (_event, buffer, fileName) => {
    try {
      const meta = stagingManager.stageFromBuffer(buffer, fileName);
      return { ok: true, file: meta };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("files:thumbnail", (_event, fileId) => {
    const dataUrl = stagingManager.getThumbnail(fileId);
    return { ok: true, dataUrl };
  });

  ipcMain.handle("files:dimensions", (_event, filePath) => {
    const dims = stagingManager.getDimensions(filePath);
    return dims ? { ok: true, ...dims } : { ok: false };
  });

  ipcMain.handle("files:clear-staging", () => {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const dir = fileStagingDir();
      if (fs.existsSync(dir)) {
        for (const name of fs.readdirSync(dir)) {
          fs.unlinkSync(path.join(dir, name));
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- State ---------------------------------------------------------------

  ipcMain.handle("state:full", () => {
    const projectState = projectManager.getAppState();
    const active = sessionManager.getActive();
    const projectsWithSessions = projectState.projects.map((p) => ({
      ...p,
      sessions: sessionManager.listForProject(p.id).map((s) => {
        const full = sessionManager.findById(s.id);
        return {
          ...s,
          messages: full?.messages || [],
        };
      }),
    }));
    const cliPath = resolveAgentCommand();
    const agent = ctx.agentBootstrap || { ok: false };
    const cliReady = Boolean(cliPath && fs.existsSync(cliPath));
    return {
      activeProjectId: projectState.activeProjectId,
      activeSessionId: sessionManager.activeSessionId,
      projects: projectsWithSessions,
      conversation: active?.messages || [],
      runnerSessionIds: runnerPool.getSessionIds(),
      runningSessionIds: getRunningSessionIds(runnerPool, sessionManager),
      agent: {
        ...agent,
        ok: cliReady,
        cliPath: cliPath || agent.cliPath || null,
        ready: cliReady,
      },
      models: listPresetsPublic(),
      permissions: require("./permission-settings").listPermissionsPublic(),
    };
  });

  ipcMain.handle("models:list", () => ({ ok: true, ...listPresetsPublic() }));

  ipcMain.handle("models:set-active", (_event, presetId) => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const result = setActivePreset(presetId);
    if (result.ok) {
      runnerPool.terminateAll();
    }
    return result.ok ? { ok: true, ...listPresetsPublic() } : result;
  });

  ipcMain.handle("permissions:list", () => ({
    ok: true,
    ...require("./permission-settings").listPermissionsPublic(),
  }));

  ipcMain.handle("permissions:set-active", (_event, modeId) => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const result = require("./permission-settings").setActivePermissionMode(modeId);
    if (result.ok) {
      runnerPool.terminateAll();
    }
    return result.ok
      ? { ok: true, ...require("./permission-settings").listPermissionsPublic() }
      : result;
  });

  ipcMain.handle("search:list", () => ({
    ok: true,
    ...require("./search-settings").listSearchSettingsPublic(),
  }));

  ipcMain.handle("search:set-provider", (_event, providerId) => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const result = require("./search-settings").setSearchProvider(providerId);
    return result.ok
      ? { ok: true, ...require("./search-settings").listSearchSettingsPublic() }
      : result;
  });

  ipcMain.handle("search:set-searxng-url", (_event, url) => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const result = require("./search-settings").setSearxngUrl(url);
    return result.ok
      ? { ok: true, ...require("./search-settings").listSearchSettingsPublic() }
      : result;
  });

  // --- Skills (P1) ---------------------------------------------------------

  ipcMain.handle("skills:list", () => ({
    ok: true,
    skills: skillManager.listSkillsPublic(),
  }));

  ipcMain.handle("skills:set-enabled", (_event, payload) => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const id = payload?.id;
    const enabled = Boolean(payload?.enabled);
    if (!id) return { ok: false, error: "NOT_FOUND" };
    const result = skillManager.setSkillEnabled(id, enabled);
    if (result.ok) {
      runnerPool.terminateAll();
      if (ctx.agentBootstrap?.agentDefaults) {
        ctx.agentBootstrap.agentDefaults.disallowedTools = skillManager.getDisallowedTools();
      }
    }
    return result;
  });

  ipcMain.handle("skills:refresh", () => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const result = skillManager.refreshSkillsConfig();
    runnerPool.terminateAll();
    return result;
  });

  ipcMain.handle("skills:restore-bundled", (_event, payload) => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const id = payload?.id;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    const result = skillManager.restoreBundledSkill(id);
    if (result.ok) {
      runnerPool.terminateAll();
    }
    return result;
  });

  ipcMain.handle("skills:get-registry-url", () => ({
    ok: true,
    registryUrl: skillManager.getRegistryUrl(),
  }));

  ipcMain.handle("skills:set-registry-url", (_event, payload) => {
    const url = payload?.url ?? payload;
    return skillManager.setRegistryUrl(url);
  });

  ipcMain.handle("skills:check-updates", async () => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    return skillManager.checkRegistryUpdates({ fetch: true });
  });

  ipcMain.handle("skills:install", async (_event, payload) => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const id = payload?.id;
    const version = payload?.version;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    const result = await skillManager.installFromRegistry(id, version);
    if (result.ok) {
      runnerPool.terminateAll();
    }
    return result;
  });

  ipcMain.handle("skills:update", async (_event, payload) => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const id = payload?.id;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    const result = await skillManager.updateFromRegistry(id);
    if (result.ok) {
      runnerPool.terminateAll();
    }
    return result;
  });

  ipcMain.handle("skills:uninstall", (_event, payload) => {
    if (anyRunnerBusy(runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    const id = payload?.id;
    if (!id) return { ok: false, error: "NOT_FOUND" };
    const result = skillManager.uninstallRemoteSkill(id);
    if (result.ok) {
      runnerPool.terminateAll();
    }
    return result;
  });

  // --- Projects ------------------------------------------------------------

  ipcMain.handle("project:list", () => projectManager.getAppState());

  ipcMain.handle("project:add", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择文件夹",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const project = projectManager.add(result.filePaths[0]);
    sessionManager.create(project.id, "默认对话");
    return { ok: true, state: projectManager.getAppState() };
  });

  ipcMain.handle("project:switch", (_event, projectId) => {
    if (!projectManager.switchTo(projectId)) {
      return { ok: false, error: "NOT_FOUND" };
    }
    const sessions = sessionManager.listForProject(projectId);
    if (sessions.length > 0) {
      sessionManager.activeSessionId = sessions[0].id;
      sessionManager.save();
      ensureSessionRunner(ctx, sessions[0].id);
    }
    return { ok: true, state: projectManager.getAppState(), sessions };
  });

  ipcMain.handle("project:rename", (_event, projectId, name) => {
    const trimmed = String(name || "").trim();
    if (!projectManager.rename(projectId, trimmed)) return { ok: false, error: "INVALID" };
    return { ok: true, state: projectManager.getAppState() };
  });

  ipcMain.handle("project:pin", (_event, projectId) => {
    if (!projectManager.togglePin(projectId)) return { ok: false, error: "NOT_FOUND" };
    return { ok: true, state: projectManager.getAppState() };
  });

  ipcMain.handle("project:open", async (_event, projectId) => {
    const project = projectManager.find(projectId);
    if (!project) return { ok: false, error: "NOT_FOUND" };
    const error = await shell.openPath(project.path);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle("project:remove", (_event, projectId) => {
    const sessionIds = sessionManager.purgeProject(projectId);
    for (const sessionId of sessionIds) {
      runnerPool.terminateSession(sessionId);
    }
    const result = projectManager.remove(projectId);
    if (result !== "OK") return { ok: false, error: result };

    const active = projectManager.getActive();
    if (!active) {
      sessionManager.activeSessionId = null;
      sessionManager.save();
    } else {
      sessionManager.ensureDefaultForProject(active.id);
      if (!sessionManager.findById(sessionManager.activeSessionId)) {
        const remaining = sessionManager.listForProject(active.id);
        if (remaining.length > 0) {
          sessionManager.switchTo(remaining[0].id);
        }
      }
    }

    return { ok: true, state: projectManager.getAppState() };
  });

  // --- Sessions ------------------------------------------------------------

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

  ipcMain.handle("session:create", (_event, title, projectId) => {
    const pid = projectId || projectManager.getActive()?.id;
    if (!pid) return { ok: false, error: "NO_PROJECT" };
    const session = sessionManager.create(pid, title);
    ensureSessionRunner(ctx, session.id);
    return { ok: true, session: { id: session.id, title: session.title, projectId: pid } };
  });

  ipcMain.handle("session:switch", (_event, sessionId) => {
    sessionManager.switchTo(sessionId);
    ensureSessionRunner(ctx, sessionId);
    const session = sessionManager.findById(sessionId);
    return {
      ok: true,
      sessionId,
      conversation: session?.messages || [],
      runnerActive: runnerPool.has(sessionId),
    };
  });

  ipcMain.handle("session:rename", (_event, sessionId, title) => {
    const trimmed = String(title || "").trim();
    if (!trimmed) return { ok: false, error: "INVALID" };
    if (!sessionManager.rename(sessionId, trimmed)) return { ok: false, error: "NOT_FOUND" };
    return { ok: true };
  });

  ipcMain.handle("session:delete", (_event, sessionId) => {
    runnerPool.terminateSession(sessionId);
    const result = sessionManager.delete(sessionId);
    if (result !== "OK") return { ok: false, error: result };
    return { ok: true };
  });

  ipcMain.handle("session:archive", (_event, sessionId) => {
    runnerPool.terminateSession(sessionId);
    sessionManager.archive(sessionId);
    return { ok: true };
  });

  // --- Assistant (stream-json) ---------------------------------------------

  ipcMain.handle("assistant:input", (_event, payload) => {
    const text = typeof payload === "string" ? payload : payload.text;
    const files = typeof payload === "object" && payload.files ? payload.files : [];

    const session = sessionManager.getActive();
    if (!session) return { ok: false, error: "NO_SESSION" };

    const blocked = diagnoseSendBlocker(ctx, session.id);
    if (blocked) {
      console.error("[assistant:input]", blocked.error, blocked.detail);
      return { ok: false, error: blocked.error, detail: blocked.detail };
    }

    const line = buildInputLine(text, files);
    if (!line) return { ok: false, error: "EMPTY" };

    const ensured = ensureSessionRunner(ctx, session.id);
    const runner = ensured.runner;
    if (!runner) {
      return {
        ok: false,
        error: ensured.error || "RUNNER_ERROR",
        detail:
          ensured.detail ||
          "无法启动助手进程，请查看终端日志或重启应用。",
      };
    }

    if (runner.isBusy() || activeTurns.has(session.id)) {
      return { ok: false, error: "BUSY" };
    }

    const fileMetadata = files.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      size: f.size,
      isImage: f.isImage,
    }));

    turnOutputs.set(session.id, "");
    activeTurns.add(session.id);

    const sent = runner.sendUserMessage(line);
    if (!sent) {
      activeTurns.delete(session.id);
      turnOutputs.delete(session.id);
      return { ok: false, error: "BUSY" };
    }

    sessionManager.pushMessageTo(
      session.id,
      "user",
      String(text || "").trim(),
      fileMetadata,
    );

    return { ok: true };
  });

  warmupActiveRunner(ctx);

  ipcMain.handle("assistant:interrupt", () => {
    const session = sessionManager.getActive();
    if (!session) return { ok: false, error: "NO_SESSION" };

    const runner = runnerPool.get(session.id);
    if (!runner?.isBusy() && !activeTurns.has(session.id)) {
      return { ok: true };
    }

    runnerPool.interrupt(session.id);
    return { ok: true };
  });
}

module.exports = { registerAll, ensureSessionRunner, warmupActiveRunner };
