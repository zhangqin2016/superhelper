"use strict";

const fs = require("node:fs");
const { resolveOpencodeCommand } = require("./agent-command");
const { sanitizeError } = require("./agent-runner");
const { fileStagingDir } = require("./config");
const {
  migrateGlobalResumeArtifacts,
  hasResumeArtifacts,
  resetSessionEngineCache,
} = require("./session-engine-recovery");
const skillManager = require("./skill-manager");

let sendPreflightConfigRefresh = null;
let lastSendPreflightConfigRefreshAt = 0;

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
  const cliPath = resolveOpencodeCommand();
  if (!cliPath) {
    return {
      error: "NO_CLI",
      detail: "The built-in assistant engine is not installed. Please fully exit the application and reopen it.",
    };
  }
  if (!fs.existsSync(cliPath)) {
    return {
      error: "NO_CLI",
      detail: `Engine file not found: ${cliPath}`,
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
      detail: "No API key configured. Please enter your key in Settings → Model/API Gateway before sending messages.",
    };
  }

  const session =
    ctx.sessionManager.findById(sessionId) || ctx.sessionManager.getActive();
  if (!session) return { error: "NO_SESSION", detail: "Please create or select a conversation first." };

  const project = resolveProjectForSession(ctx.projectManager, session);
  if (!project) {
    return { error: "NO_PROJECT", detail: "The workspace folder for this conversation no longer exists. Please add the folder again." };
  }
  if (!fs.existsSync(project.path)) {
    return {
      error: "INVALID_WORKDIR",
      detail: `Working directory does not exist: ${project.path}`,
    };
  }

  return null;
}

async function refreshRemoteConfigForSend() {
  const remoteConfig = require("./remote-config");
  if (remoteConfig.hasRemoteModelCatalogSync()) return { ok: true, skipped: true };

  const now = Date.now();
  if (now - lastSendPreflightConfigRefreshAt < 10_000 && !sendPreflightConfigRefresh) {
    return { ok: true, skipped: true };
  }

  if (!sendPreflightConfigRefresh) {
    lastSendPreflightConfigRefreshAt = now;
    sendPreflightConfigRefresh = remoteConfig
      .refreshRemoteConfig({ reason: "send_preflight" })
      .catch((err) => ({ ok: false, error: err?.message || String(err) }))
      .finally(() => {
        sendPreflightConfigRefresh = null;
      });
  }

  return Promise.race([
    sendPreflightConfigRefresh,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "TIMEOUT" }), 1500)),
  ]);
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
      detail: "Conversation not found or has been deleted. Please select or create a new conversation.",
    };
  }

  const project = resolveProjectForSession(projectManager, session);
  if (!project) {
    return {
      runner: null,
      error: "NO_PROJECT",
      detail: "The workspace folder for this conversation no longer exists. Please add the folder again.",
    };
  }

  const cliPath = resolveOpencodeCommand();
  if (!cliPath) {
    return {
      runner: null,
      error: "NO_CLI",
      detail: "The built-in assistant engine is not installed. Please fully exit the application and reopen it.",
    };
  }
  if (!fs.existsSync(cliPath)) {
    return {
      runner: null,
      error: "NO_CLI",
      detail: `Engine file not found: ${cliPath}`,
    };
  }
  if (!fs.existsSync(project.path)) {
    return {
      runner: null,
      error: "INVALID_WORKDIR",
      detail: `Working directory does not exist: ${project.path}`,
    };
  }

  const stagingDir = fileStagingDir();
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
  } catch (err) {
    console.warn("[runner] could not create staging dir:", err.message);
  }

  const configDir = skillManager.writeSessionAgentGuide(sessionId, session, project.path);
  const existingRunner = runnerPool.get(sessionId);
  const wasAlive = Boolean(existingRunner?.isAlive?.());
  if (session.agentResumeId) {
    const owner = typeof sessionManager.findAgentResumeOwner === "function"
      ? sessionManager.findAgentResumeOwner(session.agentResumeId, session.id)
      : null;
    if (owner) {
      console.warn(
        "[runner] agentResumeId %s already belongs to session %s — starting %s fresh",
        session.agentResumeId,
        owner.id,
        sessionId,
      );
      sessionManager.clearAgentResumeId(sessionId);
      resetSessionEngineCache(sessionId);
      runnerPool.terminateSession(sessionId);
    }
  }

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
    // Skills active for THIS session — scopes which learned web-system MCP
    // servers get loaded, so a disabled/unselected workspace skill no longer
    // exposes its tools (and the assistant no longer "sees" a system the user
    // turned off).
    activeSkillIds: skillManager.resolveSessionSkillIds(session),
    stagingDir,
    resumeSessionId,
    configDir,
    // An unattended (scheduled) run must not block on a permission prompt
    // nobody will answer — callers can force a non-interactive mode.
    permissionMode: opts.permissionMode
      || require("./permission-settings").resolveSessionPermissionMode(session),
  };

  try {
    const lazy = opts.spawn !== true;
    const runner = runnerPool.ensure(sessionId, project.path, extra, { lazy });
    wireRunner(ctx, runner);

    if (opts.spawn === true && !runner.isAlive()) {
      const hint = runner.lastSpawnError || "The assistant engine process failed to start.";
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
  refreshRemoteConfigForSend,
  wireRunner,
  ensureSessionRunner,
  warmupActiveRunner,
  applyPermissionModeLive,
  fileMetadataFromPayload,
  withRunnerChange,
};
