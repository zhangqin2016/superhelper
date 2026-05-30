"use strict";

const fs = require("node:fs");
const { resolveAgentCommand } = require("./agent-command");
const { sanitizeError, appendTextSegment } = require("./agent-runner");
const { fileStagingDir } = require("./config");
const {
  migrateGlobalResumeArtifacts,
  resetSessionEngineCache,
} = require("./session-engine-recovery");
const skillManager = require("./skill-manager");

/** @type {Map<string, string>} */
const lastRunnerStderr = new Map();

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

function isSessionBusy(runnerPool, sessionId, activeTurnIds = activeTurns) {
  if (!sessionId) return false;
  if (activeTurnIds.has(sessionId)) return true;
  return Boolean(runnerPool.get(sessionId)?.isBusy());
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
  const { notifySessionFinished } = require("./background-notify");

  runner.on("chunk", (text) => {
    const prev = turnOutputs.get(sessionId) || "";
    const next = appendTextSegment(prev, text);
    turnOutputs.set(sessionId, next);
    sendToRenderer(ctx.mainWindow, "assistant:chunk", { sessionId, text });
  });

  runner.on("stderr", (text) => {
    const trimmed = String(text || "").trim();
    if (trimmed) lastRunnerStderr.set(sessionId, trimmed);
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
    const inTurn = activeTurns.has(sessionId);
    activeTurns.delete(sessionId);

    const finalOutput = (output || turnOutputs.get(sessionId) || "").trim();
    turnOutputs.delete(sessionId);

    if (inTurn) {
      if (finalOutput) {
        sessionManager.pushMessageTo(sessionId, "assistant", finalOutput);
        lastRunnerStderr.delete(sessionId);
      } else if (!interrupted && code !== 0 && code !== null) {
        const stderrHint = lastRunnerStderr.get(sessionId);
        lastRunnerStderr.delete(sessionId);
        sessionManager.clearAgentResumeId(sessionId);
        resetSessionEngineCache(sessionId);
        ctx.runnerPool.terminateSession(sessionId);
        const friendly = stderrHint
          ? sanitizeError(stderrHint)
          : "这次没有收到有效回复。对话连接已重置，请再发一次（可简要说明要继续的内容）。";
        sessionManager.pushMessageTo(sessionId, "assistant", friendly, null, {
          failed: true,
        });
      } else {
        lastRunnerStderr.delete(sessionId);
      }
    }

    sessionManager.setStatus(sessionId, "idle");
    sendToRenderer(ctx.mainWindow, "assistant:done", { code, sessionId, interrupted });

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
    sessionManager.pushMessageTo(sessionId, "assistant", friendly, null, {
      failed: true,
    });
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
  const configDir = skillManager.writeSessionAgentGuide(sessionId, session);
  if (session.agentResumeId) {
    migrateGlobalResumeArtifacts(sessionId, session.agentResumeId);
  }
  const extra = {
    disallowedTools: skillManager.getDisallowedTools(),
    stagingDir,
    resumeSessionId: session.agentResumeId || null,
    configDir,
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

function fileMetadataFromPayload(files = []) {
  return files.map((f) => ({
    id: f.id,
    name: f.name,
    path: f.path,
    type: f.type,
    size: f.size,
    isImage: f.isImage,
  }));
}

function dispatchUserLine(ctx, session, text, files = [], opts = {}) {
  const { sessionManager } = ctx;
  const recordUser = opts.recordUser !== false;

  const blocked = diagnoseSendBlocker(ctx, session.id);
  if (blocked) {
    console.error("[assistant:send]", blocked.error, blocked.detail);
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

  turnOutputs.set(session.id, "");
  activeTurns.add(session.id);

  const sent = runner.sendUserMessage(line);
  if (!sent) {
    activeTurns.delete(session.id);
    turnOutputs.delete(session.id);
    return { ok: false, error: "BUSY" };
  }

  if (recordUser) {
    const fileMetadata = fileMetadataFromPayload(files);
    sessionManager.pushMessageTo(
      session.id,
      "user",
      String(text || "").trim(),
      fileMetadata,
    );
  }

  return { ok: true };
}

function withRunnerChange(ctx, action, opts = {}) {
  if (anyRunnerBusy(ctx.runnerPool)) {
    return { ok: false, error: "BUSY" };
  }
  const result = action();
  if (result.ok) {
    ctx.runnerPool.terminateAll();
    if (opts.refreshState && ctx.agentBootstrap?.agentDefaults) {
      ctx.agentBootstrap.agentDefaults.disallowedTools =
        skillManager.getDisallowedTools();
    }
  }
  return result;
}

module.exports = {
  sendToRenderer,
  turnOutputs,
  activeTurns,
  lastRunnerStderr,
  anyRunnerBusy,
  isSessionBusy,
  getRunningSessionIds,
  resolveProjectForSession,
  diagnoseSendBlocker,
  wireRunner,
  ensureSessionRunner,
  warmupActiveRunner,
  buildInputLine,
  fileMetadataFromPayload,
  dispatchUserLine,
  withRunnerChange,
};
