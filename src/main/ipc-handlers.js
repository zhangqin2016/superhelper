"use strict";

const { ipcMain, dialog, shell } = require("electron");
const FileStagingManager = require("./file-staging-manager");

// ---------------------------------------------------------------------------
// Renderer push helpers
// ---------------------------------------------------------------------------

function sendToRenderer(window, channel, payload) {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildPluginPrompt(project, pluginManager) {
  const enabled = pluginManager
    .enabledIds(project)
    .map((id) => require("./plugin-registry").findById(id))
    .filter(Boolean);

  if (enabled.length === 0) return "";

  return `当前已启用 MCP 插件：\n${enabled.map((p) => `- ${p.name}`).join("\n")}\n请在回答用户问题时主动使用相关 MCP 工具。`;
}

function buildFilePrompt(files) {
  if (!files || files.length === 0) return "";
  const paths = files.map((f) => f.path).filter(Boolean);
  const pathList = paths.map((p) => `  - ${p}`).join("\n");
  return `\n用户通过附件上传了文件，文件路径如下：\n${pathList}\n请使用 Read 工具直接查看这些文件的内容。`;
}

function buildPrompt(session, input, project, pluginManager, files = []) {
  const history = session.messages
    .slice(-8)
    .map((msg) => `${msg.role === "user" ? "用户" : "助手"}：${msg.content}`)
    .join("\n\n");

  const pluginPrompt = buildPluginPrompt(project, pluginManager);
  const filePrompt = buildFilePrompt(files);

  let prompt = "";
  if (pluginPrompt) prompt += `${pluginPrompt}\n\n`;
  if (history) prompt += `以下是当前对话上下文，请基于上下文继续回答。\n\n${history}\n\n`;
  prompt += `用户：${input}`;
  if (filePrompt) prompt += filePrompt;
  return prompt;
}

// ---------------------------------------------------------------------------
// Claude CLI flow
// ---------------------------------------------------------------------------

function handleClaude(ctx, session, project, input, files = []) {
  const { mainWindow, sessionManager, pluginManager, stagingManager, runner } = ctx;
  const sessionId = session.id;

  const mcpConfigFile = pluginManager.writeMcpConfig(project);
  const prompt = buildPrompt(session, input, project, pluginManager, files);

  const fileMetadata = files.map((f) => ({
    id: f.id, name: f.name, type: f.type, size: f.size, isImage: f.isImage,
  }));

  sessionManager.pushMessage("user", input, fileMetadata);

  let assistantOutput = "";

  runner.on("chunk", (text) => {
    assistantOutput += text;
    sendToRenderer(mainWindow, "assistant:chunk", { sessionId, text });
  });

  runner.on("stderr", (text) => {
    sendToRenderer(mainWindow, "assistant:chunk", { sessionId, text });
  });

  runner.on("done", ({ code, output }) => {
    const finalOutput = output || assistantOutput.trim();
    if (finalOutput) {
      sessionManager.pushMessage("assistant", finalOutput);
    } else if (code !== null) {
      sessionManager.pushMessage("assistant", "这次没有收到有效回复，请稍后重试。");
    }
    sessionManager.setStatus(sessionId, "idle");
    sendToRenderer(mainWindow, "assistant:done", { code, sessionId });
    cleanup();
  });

  runner.on("error", (message) => {
    const friendlyMessage = message === "BUSY"
      ? "上一条消息还在处理中，请稍后再试。"
      : require("./claude-runner").sanitizeError(message);
    sessionManager.pushMessage("assistant", friendlyMessage);
    sessionManager.setStatus(sessionId, "idle");
    sendToRenderer(mainWindow, "assistant:error", { sessionId, message: friendlyMessage });
    cleanup();
  });

  runner.on("status", (state) => {
    if (state === "thinking") sessionManager.setStatus(sessionId, "running");
    sendToRenderer(mainWindow, "assistant:status", { state, sessionId });
  });

  runner.on("tool-using", (data) => {
    sendToRenderer(mainWindow, "assistant:tool", { sessionId, ...data });
  });

  runner.on("tool-done", (data) => {
    sendToRenderer(mainWindow, "assistant:tool-done", { sessionId, ...data });
  });

  runner.run({
    prompt,
    cwd: project.path,
    mcpConfigPath: mcpConfigFile,
    stagingDir: stagingManager.getStagingDir(),
    files,
  });

  function cleanup() {
    runner.removeAllListeners("chunk");
    runner.removeAllListeners("stderr");
    runner.removeAllListeners("done");
    runner.removeAllListeners("error");
    runner.removeAllListeners("status");
    runner.removeAllListeners("tool-using");
    runner.removeAllListeners("tool-done");
  }
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

function registerAll(ctx) {
  const {
    mainWindow, projectManager, sessionManager, pluginManager,
    stagingManager, fileWatcher, diffRunner, terminalManager,
    templateStore, runner,
  } = ctx;

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

  ipcMain.handle("files:stage", (_event, filePath, fileName) => {
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

  ipcMain.handle("files:remove", (_event, fileId) => {
    return { ok: true };
  });

  ipcMain.handle("files:dimensions", (_event, filePath) => {
    const dims = stagingManager.getDimensions(filePath);
    return dims ? { ok: true, ...dims } : { ok: false };
  });

  // --- State ---------------------------------------------------------------

  ipcMain.handle("state:full", () => {
    const projectState = projectManager.getAppState();
    const projectsWithSessions = projectState.projects.map((p) => ({
      ...p,
      sessions: sessionManager.listForProject(p.id),
    }));
    const activeSession = sessionManager.getActive();
    return {
      activeProjectId: projectState.activeProjectId,
      activeSessionId: sessionManager.activeSessionId,
      projects: projectsWithSessions,
      conversation: activeSession ? activeSession.messages : [],
    };
  });

  // --- Projects ------------------------------------------------------------

  ipcMain.handle("project:list", () => projectManager.getAppState());

  ipcMain.handle("project:add", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择项目目录",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const project = projectManager.add(result.filePaths[0]);
    sessionManager.create(project.id, "默认会话");
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
    }
    fileWatcher.watch(projectId, projectManager.find(projectId).path);
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
    if (runner.isBusy()) return { ok: false, error: "BUSY" };
    const result = projectManager.remove(projectId);
    if (result !== "OK") return { ok: false, error: result };
    return { ok: true, state: projectManager.getAppState() };
  });

  // --- Sessions ------------------------------------------------------------

  ipcMain.handle("session:list", () => {
    const project = projectManager.getActive();
    return {
      sessions: sessionManager.listForProject(project.id),
      activeSessionId: sessionManager.activeSessionId,
    };
  });

  ipcMain.handle("session:create", (_event, title, projectId) => {
    const pid = projectId || projectManager.getActive().id;
    const session = sessionManager.create(pid, title);
    sessionManager.clearConversation(session.id);
    return { ok: true, session: { id: session.id, title: session.title, projectId: pid } };
  });

  ipcMain.handle("session:switch", (_event, sessionId) => {
    sessionManager.switchTo(sessionId);
    const session = sessionManager.getActive();
    return { ok: true, conversation: session ? session.messages : [] };
  });

  ipcMain.handle("session:rename", (_event, sessionId, title) => {
    if (!sessionManager.rename(sessionId, title)) return { ok: false, error: "NOT_FOUND" };
    return { ok: true };
  });

  ipcMain.handle("session:delete", (_event, sessionId) => {
    const result = sessionManager.delete(sessionId);
    if (result !== "OK") return { ok: false, error: result };
    return { ok: true };
  });

  ipcMain.handle("session:archive", (_event, sessionId) => {
    sessionManager.archive(sessionId);
    return { ok: true };
  });

  // --- Assistant -----------------------------------------------------------

  ipcMain.handle("assistant:input", (_event, payload) => {
    const text = typeof payload === "string" ? payload : payload.text;
    const files = (typeof payload === "object" && payload.files) ? payload.files : [];

    const prompt = String(text || "").trim();
    if (!prompt && files.length === 0) return { ok: false, error: "EMPTY" };
    if (runner.isBusy()) return { ok: false, error: "BUSY" };

    const project = projectManager.getActive();
    const session = sessionManager.getActive();
    if (!session) return { ok: false, error: "NO_SESSION" };

    handleClaude(ctx, session, project, prompt, files);
    return { ok: true };
  });

  ipcMain.handle("assistant:interrupt", () => {
    runner.interrupt();
    const session = sessionManager.getActive();
    if (session) sessionManager.setStatus(session.id, "idle");
    sendToRenderer(mainWindow, "assistant:done", { code: null, sessionId: session?.id });
    return { ok: true };
  });

  ipcMain.handle("assistant:restart", () => {
    runner.terminate();
    const session = sessionManager.getActive();
    if (session) {
      sessionManager.clearConversation(session.id);
      sessionManager.setStatus(session.id, "idle");
    }
    sendToRenderer(mainWindow, "assistant:status", { state: "ready", sessionId: session?.id });
    return { ok: true };
  });

  // --- File Tree -----------------------------------------------------------

  ipcMain.handle("filetree:get", (_event, projectId) => {
    const tree = projectManager.scanDirectory(projectId || projectManager.getActive().id);
    return { ok: true, tree };
  });

  ipcMain.handle("filetree:watch", (_event, projectId) => {
    const project = projectManager.find(projectId) || projectManager.getActive();
    if (!project) return { ok: false };
    fileWatcher.watch(project.id, project.path);
    return { ok: true };
  });

  ipcMain.handle("filetree:unwatch", (_event, projectId) => {
    fileWatcher.unwatch(projectId);
    return { ok: true };
  });

  // --- Diff ----------------------------------------------------------------

  ipcMain.handle("diff:get", async (_event, projectId) => {
    const project = projectManager.find(projectId) || projectManager.getActive();
    if (!project) return { ok: false };
    const result = await diffRunner.getDiff(project.path);
    return { ok: true, ...result };
  });

  ipcMain.handle("diff:accept", async (_event, projectId, filePaths) => {
    const project = projectManager.find(projectId) || projectManager.getActive();
    if (!project) return { ok: false };
    const result = await diffRunner.acceptFiles(project.path, filePaths);
    return result;
  });

  ipcMain.handle("diff:reject", async (_event, projectId, filePaths) => {
    const project = projectManager.find(projectId) || projectManager.getActive();
    if (!project) return { ok: false };
    const result = await diffRunner.rejectFiles(project.path, filePaths);
    return result;
  });

  // --- Terminal ------------------------------------------------------------

  ipcMain.handle("terminal:create", (_event, { terminalId, cwd, cols, rows }) => {
    terminalManager.create(terminalId, { cwd, cols, rows });
    return { ok: true };
  });

  ipcMain.handle("terminal:write", (_event, terminalId, data) => {
    terminalManager.write(terminalId, data);
    return { ok: true };
  });

  ipcMain.handle("terminal:resize", (_event, terminalId, cols, rows) => {
    terminalManager.resize(terminalId, cols, rows);
    return { ok: true };
  });

  ipcMain.handle("terminal:destroy", (_event, terminalId) => {
    terminalManager.destroy(terminalId);
    return { ok: true };
  });

  // --- Templates -----------------------------------------------------------

  ipcMain.handle("templates:list", () => {
    return { ok: true, templates: templateStore.listAll() };
  });

  ipcMain.handle("templates:add", (_event, title, prompt) => {
    const template = templateStore.add(title, prompt);
    return { ok: true, template };
  });

  ipcMain.handle("templates:remove", (_event, id) => {
    templateStore.remove(id);
    return { ok: true };
  });

  // --- Plugins -------------------------------------------------------------

  ipcMain.handle("plugins:list", () => pluginManager.getMarketState());

  ipcMain.handle("plugins:install", (_event, pluginId, scope) => {
    if (!pluginManager.install(pluginId, scope)) return { ok: false, error: "INVALID" };
    return { ok: true, state: pluginManager.getMarketState() };
  });

  ipcMain.handle("plugins:set-enabled", (_event, pluginId, scope, enabled) => {
    if (!pluginManager.setEnabled(pluginId, scope, enabled)) return { ok: false, error: "NOT_INSTALLED" };
    return { ok: true, state: pluginManager.getMarketState() };
  });

  ipcMain.handle("plugins:uninstall", (_event, pluginId, scope) => {
    pluginManager.uninstall(pluginId, scope);
    return { ok: true, state: pluginManager.getMarketState() };
  });

  // --- File watcher events to renderer -------------------------------------

  fileWatcher.on("change", ({ projectId, eventType, filename }) => {
    sendToRenderer(mainWindow, "filetree:change", { projectId, eventType, filename });
  });

  // --- Terminal events to renderer -----------------------------------------

  terminalManager.on("data", ({ terminalId, data }) => {
    sendToRenderer(mainWindow, "terminal:data", { terminalId, data });
  });

  terminalManager.on("exit", ({ terminalId, exitCode }) => {
    sendToRenderer(mainWindow, "terminal:exit", { terminalId, exitCode });
  });

  terminalManager.on("error", ({ terminalId, message }) => {
    sendToRenderer(mainWindow, "terminal:error", { terminalId, message });
  });
}

module.exports = { registerAll };
