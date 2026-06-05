"use strict";

const fs = require("node:fs");
const { resolveAgentCommand } = require("./agent-command");
const { sanitizeError } = require("./agent-runner");
const { fileStagingDir } = require("./config");
const {
  migrateGlobalResumeArtifacts,
  hasResumeArtifacts,
  resetSessionEngineCache,
} = require("./session-engine-recovery");
const skillManager = require("./skill-manager");

function sendToRenderer(window, channel, payload) {
  if (window && !window.isDestroyed()) {
    window.webContents.send(channel, payload);
  }
}

function anyRunnerBusy(runnerPool) {
  for (const sessionId of runnerPool.getSessionIds()) {
    const runner = runnerPool.get(sessionId);
    if (runner?.isBusy()) return true;
  }
  return false;
}

function isSessionBusy(runnerPool, sessionId) {
  if (!sessionId) return false;
  return Boolean(runnerPool.get(sessionId)?.isBusy());
}

function getRunningSessionIds(runnerPool) {
  return runnerPool.getSessionIds().filter((sessionId) => runnerPool.get(sessionId)?.isBusy());
}

function resolveProjectForSession(projectManager, session) {
  if (!session) return null;
  return projectManager.find(session.projectId) || null;
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

  const { loadSettingsEnv } = require("./agent-settings");
  const { getUserApiEnv, getActivePresetEnv } = require("./model-presets");
  const { normalizeToLilyEnv } = require("./agent-env");
  const lilyEnv = normalizeToLilyEnv({
    ...loadSettingsEnv(),
    ...getUserApiEnv(),
    ...getActivePresetEnv(),
  });
  if (!String(lilyEnv.LILY_API_KEY || "").trim()) {
    return {
      error: "NO_API_KEY",
      detail: "未配置 API Key。请在设置 → 模型/API 网关中填写密钥后再发送消息。",
    };
  }

  const session =
    ctx.sessionManager.findById(sessionId) || ctx.sessionManager.getActive();
  if (!session) return { error: "NO_SESSION", detail: "请先创建或选择一个对话。" };

  const project = resolveProjectForSession(ctx.projectManager, session);
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
  runner.bindOrchestrator?.(ctx.turnOrchestrator);
  ctx.turnOrchestrator?.bindRunner(runner);
}

function ensureSessionRunner(ctx, sessionId, opts = {}) {
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
  const existingRunner = runnerPool.get(sessionId);
  const wasAlive = Boolean(existingRunner?.isAlive?.());
  if (session.agentResumeId) {
    migrateGlobalResumeArtifacts(sessionId, session.agentResumeId);
    if (!hasResumeArtifacts(sessionId, session.agentResumeId)) {
      console.warn("[runner] stale agentResumeId for session %s — starting fresh", sessionId);
      sessionManager.clearAgentResumeId(sessionId);
      resetSessionEngineCache(sessionId);
      runnerPool.terminateSession(sessionId);
    }
  }

  const resumeSessionId = session.agentResumeId || null;
  const extra = {
    disallowedTools: skillManager.getDisallowedTools(),
    stagingDir,
    resumeSessionId,
    configDir,
    permissionMode: require("./permission-settings").resolveSessionPermissionMode(session),
  };

  try {
    const lazy = opts.spawn !== true;
    const runner = runnerPool.ensure(sessionId, project.path, extra, { lazy });
    wireRunner(ctx, runner);

    if (opts.spawn === true && !runner.isAlive()) {
      const hint = runner.lastSpawnError || "助手引擎进程未能启动。";
      return { runner: null, error: "RUNNER_ERROR", detail: hint };
    }

    return {
      runner,
      coldStart: opts.spawn === true && !wasAlive,
      usedResume: Boolean(resumeSessionId),
      project,
    };
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

function warmupActiveRunner(_ctx) {}

function applyPermissionModeLive(ctx, modeId) {
  if (anyRunnerBusy(ctx.runnerPool)) {
    return { ok: false, error: "BUSY" };
  }
  const r = require("./permission-settings").setActivePermissionMode(modeId);
  if (!r.ok) return r;
  ctx.runnerPool.applyPermissionMode(modeId, (sessionId) => {
    const session = ctx.sessionManager.findById(sessionId);
    return !require("./permission-settings").normalizeSessionPermissionMode(session?.permissionModeId);
  });
  return { ok: true, ...require("./permission-settings").listPermissionsPublic() };
}

function fileMetadataFromPayload(files = []) {
  return files.map((f) => ({
    id: f.id,
    name: f.name,
    path: f.path,
    type: f.type,
    size: f.size,
    isImage: f.isImage,
    thumbnail: f.thumbnail || null,
  }));
}

async function withRunnerChange(ctx, action, opts = {}) {
  if (anyRunnerBusy(ctx.runnerPool)) {
    return { ok: false, error: "BUSY" };
  }
  const result = await action();
  if (!result?.ok) return result || { ok: false, error: "UNKNOWN" };

  const {
    buildLiveEngineEnvPatch,
    applyLiveEnvToPool,
    terminateIdleRunners,
    reloadSkillsForIdleRunners,
  } = require("./runner-live-config");

  if (opts.liveEnv === false) {
    if (opts.reloadSkills) reloadSkillsForIdleRunners(ctx.runnerPool);
    else terminateIdleRunners(ctx.runnerPool);
  } else {
    const patch = buildLiveEngineEnvPatch();
    const { failed } = applyLiveEnvToPool(ctx.runnerPool, patch);
    for (const sessionId of failed) ctx.runnerPool.terminateSession(sessionId);
  }

  if (opts.refreshState && ctx.agentBootstrap?.agentDefaults) {
    ctx.agentBootstrap.agentDefaults.disallowedTools = skillManager.getDisallowedTools();
  }
  return result;
}

module.exports = {
  sendToRenderer,
  anyRunnerBusy,
  isSessionBusy,
  getRunningSessionIds,
  resolveProjectForSession,
  diagnoseSendBlocker,
  wireRunner,
  ensureSessionRunner,
  warmupActiveRunner,
  applyPermissionModeLive,
  fileMetadataFromPayload,
  withRunnerChange,
};
