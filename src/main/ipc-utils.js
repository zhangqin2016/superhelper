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

// Below this the next message write is likely to die with SQLITE_FULL/ENOSPC.
const SEND_MIN_FREE_BYTES = 100 * 1024 * 1024;

/** statfs the userData volume; fail-open (unknown = plenty). */
function checkSendDiskSpace(options = {}) {
  try {
    const statfs = options.statfsSync || fs.statfsSync;
    const userData = require("./config").userDataPath(".");
    const stats = statfs(userData);
    const free = Number(stats?.bavail) * Number(stats?.bsize);
    if (!Number.isFinite(free) || free >= SEND_MIN_FREE_BYTES) return null;
    return { error: "LOW_DISK_SPACE" };
  } catch {
    return null; // statfs unsupported / path missing — never block a send on a probe
  }
}

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

function diagnoseSendBlocker(ctx, sessionId, options = {}) {
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

  // Disk-full is otherwise discovered as a raw SQLITE_FULL mid-send (and, on
  // older builds, a wedged session queue). Fail BEFORE the turn starts, in
  // plain language, while the session is still intact.
  const disk = checkSendDiskSpace();
  if (disk) return disk;

  const { resolveLilyEnv } = require("./spawn-env");
  const lilyEnv = options.modelExecution?.env || resolveLilyEnv();
  const modelConnection = require("./model-presets").getActiveModelConnectionStatus(lilyEnv);
  if (!modelConnection.ok) return { error: modelConnection.error, detail: modelConnection.detail };

  const session = ctx.sessionManager.findById(sessionId);
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

async function refreshRemoteConfigForSend(options = {}) {
  const remoteConfig = require("./remote-config");
  const force = Boolean(options.force);
  const timeoutMs = Number(options.timeoutMs || 1500);
  if (!force && remoteConfig.hasRemoteModelCatalogSync()) return { ok: true, skipped: true };

  const now = Date.now();
  if (!force && now - lastSendPreflightConfigRefreshAt < 10_000 && !sendPreflightConfigRefresh) {
    return { ok: true, skipped: true };
  }

  if (!sendPreflightConfigRefresh) {
    lastSendPreflightConfigRefreshAt = now;
    sendPreflightConfigRefresh = Promise.resolve()
      .then(async () => {
        if (options.repairManagedService) {
          const service = require("./service-client");
          await Promise.resolve(service.refreshClientBootstrap({ force: true })).catch(() => null);
          await Promise.resolve(service.registerDevice()).catch(() => null);
          if (options.refreshLicense !== false) {
            await Promise.resolve(require("./license-manager").refreshServerLicense()).catch(() => null);
          }
        }
        return remoteConfig.refreshRemoteConfig({ reason: options.reason || "send_preflight" });
      })
      .catch((err) => ({ ok: false, error: err?.message || String(err) }))
      .finally(() => {
        sendPreflightConfigRefresh = null;
      });
  }

  let timeoutId = null;
  try {
    return await Promise.race([
      sendPreflightConfigRefresh,
      new Promise((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ ok: false, error: "TIMEOUT" }),
          Math.max(500, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function wireRunner(ctx, runner) {
  runner?.bindOrchestrator?.(ctx.turnOrchestrator);
  if (!runner) return false;
  ctx.turnOrchestrator?.bindRunner(runner);
  return true;
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
  let wasAlive = Boolean(existingRunner?.isAlive?.());
  const activeSkillIds = skillManager.resolveSessionSkillIds(session);
  const { buildResumeBinding, verifyResumeBinding } = require("./resume-binding");
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
      wasAlive = false;
    }
  }

  if (session.agentResumeId) {
    const expectedBinding = buildResumeBinding({
      session,
      project,
      activeSkillIds,
      sessionManager,
      resumeId: session.agentResumeId,
    });
    const binding = verifyResumeBinding(session, expectedBinding);
    if (!binding.ok) {
      console.warn(
        "[runner] agentResumeId binding mismatch for session %s (%s) - starting fresh",
        sessionId,
        binding.reason,
      );
      sessionManager.clearAgentResumeId(sessionId);
      resetSessionEngineCache(sessionId);
      runnerPool.terminateSession(sessionId);
      wasAlive = false;
    }
  }

  if (session.agentResumeId) {
    migrateGlobalResumeArtifacts(sessionId, session.agentResumeId);
    if (!hasResumeArtifacts(sessionId, session.agentResumeId)) {
      console.warn("[runner] stale agentResumeId for session %s — starting fresh", sessionId);
      sessionManager.clearAgentResumeId(sessionId);
      resetSessionEngineCache(sessionId);
      runnerPool.terminateSession(sessionId);
      wasAlive = false;
    }
  }

  const resumeSessionId = session.agentResumeId || null;
  const runtimeIdentityOwner = sessionManager.resolveTurnOwnerScope?.(sessionId);
  const extra = {
    disallowedTools: [...new Set([...skillManager.getDisallowedTools(), ...(opts.disallowedTools || [])])],
    // Skills active for THIS session — scopes which learned web-system MCP
    // servers get loaded, so a disabled/unselected workspace skill no longer
    // exposes its tools (and the assistant no longer "sees" a system the user
    // turned off).
    activeSkillIds,
    stagingDir,
    resumeSessionId,
    configDir,
    modelExecution: opts.modelExecution || null,
    modelPool: require("./turn-model-runtime").runtimeModelPool(opts.modelPool),
    // An unattended (scheduled) run must not block on a permission prompt
    // nobody will answer — callers can force a non-interactive mode.
    permissionMode: opts.permissionMode
      || require("./permission-settings").resolveSessionPermissionMode(session),
    runtimeIdentityClaims: {
      principalId: runtimeIdentityOwner?.ok && runtimeIdentityOwner.ownerScope
        ? runtimeIdentityOwner.ownerScope
        : `session:${sessionId}`,
      workspaceId: session.projectId || "workspace:local",
      projectId: session.projectId || "project:local",
    },
  };
  if (opts.turnId) {
    try {
      const owner = sessionManager.resolveTurnOwnerScope?.(sessionId);
      if (owner?.ok && owner.ownerScope) {
        extra.processJobGuidance = require("./long-task/turn-scope").buildProcessJobTurnGuidance({
          secret: require("./long-task/secret").ensureLongTaskSecret(),
          scope: {
            ownerScope: owner.ownerScope,
            sessionId,
            projectId: session.projectId,
            turnId: opts.turnId,
          },
        });
      }
    } catch (err) {
      console.warn("[runner] process-job scope unavailable:", err?.message || err);
    }
  }

  try {
    const lazy = opts.spawn !== true;
    const runner = runnerPool.ensure(sessionId, project.path, extra, { lazy });
    if (!runner) {
      return {
        runner: null,
        error: "RUNNER_UNAVAILABLE",
        detail: "The assistant process could not be allocated for this conversation.",
      };
    }
    wireRunner(ctx, runner);

    if (opts.spawn === true && !runner.isAlive()) {
      // One in-place recovery before giving up: an engine that failed to start
      // never ran anything, so dropping the corpse and building a fresh runner
      // is always safe. isAlive() counts an in-flight start as alive, so this
      // branch only fires when there is genuinely no process and no start
      // attempt (e.g. a previous async start failed and cleared itself).
      const firstSpawnError = runner.lastSpawnError || "";
      runnerPool.terminateSession(sessionId);
      const fresh = runnerPool.ensure(sessionId, project.path, extra, { lazy: false });
      if (!fresh) {
        return {
          runner: null,
          error: "RUNNER_UNAVAILABLE",
          detail: firstSpawnError || "The assistant process could not be rebuilt for this conversation.",
        };
      }
      wireRunner(ctx, fresh);
      if (fresh.isAlive()) {
        console.warn("[runner]", sessionId, "engine was dead at preflight; rebuilt a fresh runner");
        return {
          runner: fresh,
          coldStart: true,
          usedResume: Boolean(resumeSessionId),
          project,
        };
      }
      const hint = fresh.lastSpawnError || firstSpawnError || "The assistant engine process failed to start.";
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
    // Engine binary not bundled/resolvable: return a specific code (no raw detail)
    // so the renderer shows a localized "engine missing — reinstall" message rather
    // than the opaque "OPENCODE_NOT_READY". This is the symptom of a build that
    // shipped without the platform engine.
    if (err.message === "OPENCODE_NOT_READY" || err.code === "OPENCODE_NOT_READY") {
      return { runner: null, error: "OPENCODE_NOT_READY" };
    }
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
  return (files || []).filter(Boolean).map((f) => ({
    id: f.id,
    name: f.name,
    path: f.path,
    sourcePath: f.sourcePath,
    staged: f.staged,
    pathOnly: f.pathOnly,
    readable: f.readable,
    kind: f.kind,
    isDirectory: f.isDirectory,
    extension: f.extension,
    type: f.type,
    size: f.size,
    isImage: f.isImage,
    dimensions: f.dimensions,
    thumbnail: f.thumbnail || null,
  }));
}

function fileMetadataKeys(file) {
  if (!file || typeof file !== "object") return [];
  return [file.id, file.path, file.sourcePath, file.name].filter(Boolean);
}

function findSourceFileMetadata(byKey, display) {
  for (const key of fileMetadataKeys(display)) {
    if (byKey.has(key)) return byKey.get(key);
  }
  return null;
}

function mergeDisplayFileMetadata(sourceFiles = [], displayFiles = null) {
  const sourceMeta = fileMetadataFromPayload(sourceFiles);
  const byKey = new Map();
  for (const file of sourceMeta) {
    for (const key of fileMetadataKeys(file)) {
      byKey.set(key, file);
    }
  }
  if (!Array.isArray(displayFiles)) return sourceMeta;
  return displayFiles.filter(Boolean).map((display) => {
    const source = findSourceFileMetadata(byKey, display);
    return {
      ...(source || {}),
      ...display,
      path: display.path || source?.path,
      sourcePath: display.sourcePath || source?.sourcePath,
      staged: display.staged ?? source?.staged,
      pathOnly: display.pathOnly ?? source?.pathOnly,
      readable: display.readable ?? source?.readable,
      kind: display.kind || source?.kind,
      isDirectory: display.isDirectory ?? source?.isDirectory,
      extension: display.extension || source?.extension,
      type: display.type || source?.type,
      size: display.size ?? source?.size,
      isImage: display.isImage ?? source?.isImage,
      dimensions: display.dimensions || source?.dimensions,
      thumbnail: display.thumbnail || source?.thumbnail || null,
    };
  });
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
  checkSendDiskSpace,
  refreshRemoteConfigForSend,
  wireRunner,
  ensureSessionRunner,
  warmupActiveRunner,
  applyPermissionModeLive,
  fileMetadataFromPayload,
  mergeDisplayFileMetadata,
  withRunnerChange,
};
