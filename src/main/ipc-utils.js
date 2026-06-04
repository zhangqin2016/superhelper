"use strict";

const fs = require("node:fs");
const { resolveAgentCommand } = require("./agent-command");
const { sanitizeError, normalizeAssistantOutput } = require("./agent-runner");
const { fileStagingDir } = require("./config");
const {
  migrateGlobalResumeArtifacts,
  hasResumeArtifacts,
  resetSessionEngineCache,
} = require("./session-engine-recovery");
const skillManager = require("./skill-manager");
const { turnState, emitTurnState } = require("./session-turn-state");
const { turnController } = require("./turn-controller");
const {
  recordTurnPayload,
  cancelAutoRecovery,
  clearTurnPayloadOnSuccess,
  scheduleAutoRecovery,
  isRecoverableFailure,
  isRecoveryPending,
} = require("./turn-auto-recovery");
const {
  enqueueMessage,
  clearMessageQueue,
  emitQueueState,
  queueLength,
} = require("./turn-message-queue");
const {
  emitSessionEvents,
  buildUserCommittedEvent,
} = require("./session-events");

/** @type {Map<string, string>} */
const lastRunnerStderr = new Map();

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
  const runner = runnerPool.get(sessionId);
  if (runner?.isBusy()) return true;
  return turnState.has(sessionId);
}

function getRunningSessionIds(runnerPool) {
  return turnState.getRunningSessionIds(runnerPool);
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
  const currentTurnPayload = (payload = {}) => ({
    sessionId,
    turnId: turnController.getTurnId(sessionId),
    ...payload,
  });
  const sendTurnEvent = (channel, payload = {}) => {
    sendToRenderer(ctx.mainWindow, channel, currentTurnPayload(payload));
  };

  runner.on("chunk", (text) => {
    turnController.transition(sessionId, "engineAccepted");
    turnState.append(sessionId, text);
    sendTurnEvent("assistant:chunk", { text });
  });

  runner.on("stderr", (text) => {
    const trimmed = String(text || "").trim();
    if (trimmed) lastRunnerStderr.set(sessionId, trimmed);
    console.error(`[agent stderr ${sessionId}]`, text);
  });

  runner.on("tool-using", (data) => {
    turnController.transition(sessionId, "toolStart");
    emitTurnState(ctx, sessionId);
    require("./usage-reporter").recordToolCall(sessionId, data);
    const { captureBeforeSnapshot } = require("./diff-capture");
    captureBeforeSnapshot(sessionId, data.id, data.name, data.input);
    sendTurnEvent("assistant:tool", data);
  });

  // Stream event: tool card placeholder (name/id before full input arrives)
  runner.on("tool-upcoming", (data) => {
    sendTurnEvent("assistant:tool-upcoming", data);
  });

  // Stream event: incremental tool input
  runner.on("tool-input-delta", (data) => {
    sendTurnEvent("assistant:tool-input-delta", data);
  });

  // Stream event: tool input complete (from assistant event, for pre-created cards)
  runner.on("tool-input-done", (data) => {
    sendTurnEvent("assistant:tool-input-done", data);
  });

  runner.on("tool-done", (data) => {
    turnController.transition(sessionId, "toolEnd");
    emitTurnState(ctx, sessionId);
    sendTurnEvent("assistant:tool-done", data);
    const { emitDiffForTool } = require("./diff-capture");
    emitDiffForTool(sessionId, data.id, ctx);
  });

  runner.on("permission-request", (data) => {
    turnController.transition(sessionId, "permissionRequest");
    emitTurnState(ctx, sessionId);
    sendTurnEvent("assistant:permission-request", data);
  });

  runner.on("ask-user-question", (data) => {
    turnController.transition(sessionId, "permissionRequest");
    emitTurnState(ctx, sessionId);
    sendTurnEvent("assistant:user-question", data);
  });

  runner.on("permission-cancelled", (data) => {
    turnController.transition(sessionId, "permissionResolved");
    emitTurnState(ctx, sessionId);
    sendTurnEvent("assistant:permission-cancelled", data);
  });

  runner.on("hook-request", (data) => {
    turnController.transition(sessionId, "permissionRequest");
    emitTurnState(ctx, sessionId);
    sendTurnEvent("assistant:hook-request", data);
  });

  runner.on("hook-resolved", (data) => {
    turnController.transition(sessionId, "permissionResolved");
    emitTurnState(ctx, sessionId);
    sendTurnEvent("assistant:hook-resolved", data);
  });

  runner.on("engine-notice", (data) => {
    sendTurnEvent("assistant:engine-notice", data);
  });

  runner.on("prompt-suggestions", (data) => {
    sendToRenderer(ctx.mainWindow, "assistant:prompt-suggestions", {
      sessionId,
      ...data,
    });
  });

  runner.on("status", (state) => {
    if (state === "thinking") {
      turnController.transition(sessionId, "engineAccepted");
      emitTurnState(ctx, sessionId);
    }
    sendTurnEvent("assistant:status", { state });
  });

  runner.on("agent-resume-id", (agentResumeId) => {
    sessionManager.setAgentResumeId(sessionId, agentResumeId);
  });

  runner.on("resume-invalid", () => {
    sendTurnEvent("assistant:engine-notice", {
      code: "sessionRefresh",
      level: "info",
      panel: true,
      toast: true,
      done: true,
    });
    sessionManager.clearAgentResumeId(sessionId);
    resetSessionEngineCache(sessionId);
    ctx.runnerPool.terminateSession(sessionId);
  });

  runner.on("done", async ({ code, output, interrupted, stalled }) => {
    const inTurn = turnState.has(sessionId);
    const endReason = interrupted
      ? "interrupted"
      : stalled
        ? "stalled"
        : !interrupted && code !== 0 && code !== null
          ? "error"
          : "completed";
    const { turnId, output: storedOutput, wasActive } = turnController.completeTurn(
      sessionId,
      endReason,
    );
    emitTurnState(ctx, sessionId);
    const finalOutput = (output || storedOutput || "").trim();
    const normalized = normalizeAssistantOutput(finalOutput);

    if (interrupted) {
      clearTurnPayloadOnSuccess(sessionId);
    } else if (normalized.text && !normalized.failed) {
      clearTurnPayloadOnSuccess(sessionId);
    }

    const recoveryMeta = {
      turnId,
      mainWindow: ctx.mainWindow,
      sendToRenderer,
    };

    if (!interrupted && !stalled && (inTurn || wasActive)) {
      const stderrHint = lastRunnerStderr.get(sessionId);
      const recoverReason = normalized.failed
        ? finalOutput
        : stderrHint && !normalized.text
          ? stderrHint
          : null;
      if (
        recoverReason &&
        isRecoverableFailure(recoverReason) &&
        scheduleAutoRecovery(ctx, sessionId, recoverReason, recoveryMeta)
      ) {
        lastRunnerStderr.delete(sessionId);
        turnController.finalizeTurn(sessionId);
        emitTurnState(ctx, sessionId);
        return;
      }
    }

    if (inTurn || wasActive) {
      if (normalized.text) {
        sessionManager.pushMessageTo(
          sessionId,
          "assistant",
          normalized.text,
          null,
          normalized.failed ? { failed: true } : null,
        );
        lastRunnerStderr.delete(sessionId);
      } else if (stalled || interrupted) {
        lastRunnerStderr.delete(sessionId);
      } else if (
        !interrupted &&
        sessionManager.findById(sessionId)?.agentResumeId
      ) {
        lastRunnerStderr.delete(sessionId);
        sessionManager.clearAgentResumeId(sessionId);
        resetSessionEngineCache(sessionId);
        ctx.runnerPool.terminateSession(sessionId);
        sessionManager.pushMessageTo(
          sessionId,
          "assistant",
          "对话上下文已失效（可能因重启中断）。已重置连接，请再发一次消息。",
          null,
          { failed: true },
        );
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
      } else if (!interrupted) {
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
    } else if (normalized.text) {
      const session = sessionManager.findById(sessionId);
      const last = session?.messages?.[session.messages.length - 1];
      if (!last || last.role !== "assistant" || last.content !== normalized.text) {
        sessionManager.pushMessageTo(
          sessionId,
          "assistant",
          normalized.text,
          null,
          normalized.failed ? { failed: true } : null,
        );
      }
      lastRunnerStderr.delete(sessionId);
    }

    const sessionForNotify = sessionManager.findById(sessionId);
    const { emitTurnBoundary } = require("./turn-boundary");
    let assistantPayload = null;
    if (normalized.text) {
      assistantPayload = {
        text: normalized.text,
        failed: Boolean(normalized.failed),
      };
    } else if (!interrupted && !stalled) {
      const last = sessionForNotify?.messages?.[sessionForNotify.messages.length - 1];
      if (last?.role === "assistant") {
        assistantPayload = { text: last.content, failed: Boolean(last.failed) };
      }
    }

    await emitTurnBoundary(ctx, sessionId, {
      turnId,
      endReason,
      interrupted,
      stalled: Boolean(stalled),
      hadOutput: Boolean(normalized.text),
      assistant: assistantPayload,
    });
    await require("./usage-reporter").flush(sessionId);

    sendToRenderer(ctx.mainWindow, "assistant:done", {
      code,
      sessionId,
      turnId,
      interrupted,
      stalled: Boolean(stalled),
      hadOutput: Boolean(normalized.text),
    });

    const wasFocused = ctx.mainWindow?.isFocused?.() ?? true;
    if (!wasFocused) {
      notifySessionFinished(ctx.mainWindow, {
        sessionId,
        sessionTitle: sessionForNotify?.title,
        ok: Boolean(normalized.text),
        body: normalized.text,
      });
    }
  });

  runner.on("error", async (message) => {
    if (!turnState.has(sessionId)) return;
    const { turnId } = turnController.completeTurn(sessionId, "error");
    emitTurnState(ctx, sessionId);
    const { clearDiffsForSession } = require("./diff-capture");
    clearDiffsForSession(sessionId);

    const recoveryMeta = {
      turnId,
      mainWindow: ctx.mainWindow,
      sendToRenderer,
    };
    if (
      message !== "BUSY" &&
      scheduleAutoRecovery(ctx, sessionId, String(message), recoveryMeta)
    ) {
      turnController.finalizeTurn(sessionId);
      emitTurnState(ctx, sessionId);
      return;
    }

    cancelAutoRecovery(sessionId);
    const friendly =
      message === "BUSY"
        ? "上一条消息还在处理中，请稍后再试。"
        : sanitizeError(String(message));
    sessionManager.pushMessageTo(sessionId, "assistant", friendly, null, {
      failed: true,
    });
    emitTurnState(ctx, sessionId);
    sendToRenderer(ctx.mainWindow, "assistant:error", {
      sessionId,
      turnId,
      message: friendly,
    });
    const { emitTurnBoundary } = require("./turn-boundary");
    await emitTurnBoundary(ctx, sessionId, {
      turnId,
      endReason: "error",
      interrupted: false,
      stalled: false,
      hadOutput: true,
      assistant: { text: friendly, failed: true },
    });
    await require("./usage-reporter").flush(sessionId);
  });
}

/**
 * @returns {{ runner: import('./agent-session').AgentSession | null, error?: string, detail?: string, coldStart?: boolean, usedResume?: boolean, project?: Record<string, unknown> }}
 */
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
      console.warn(
        "[runner] stale agentResumeId for session %s — starting fresh",
        sessionId,
      );
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

function warmupActiveRunner(_ctx) {
  // Lazy spawn: CLI starts on first user message to avoid idle processes.
}

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

function notifyUserMessageCommitted(ctx, sessionId, text, files, displayFiles, opts = {}) {
  if (opts.skipSessionEvents) return null;
  const meta =
    displayFiles?.length > 0
      ? displayFiles
      : fileMetadataFromPayload(files);
  const event = buildUserCommittedEvent(sessionId, text, meta.length ? meta : null, {
    immediate: !opts.fromQueue,
    fromQueue: Boolean(opts.fromQueue),
  });
  emitSessionEvents(ctx, sessionId, [event]);
  return event;
}

function shouldQueueUserLine(sessionId, runner, opts = {}) {
  if (opts.fromAutoRecovery || opts.fromQueue) return false;
  const snap = turnController.snapshot(sessionId);
  if (snap.phase === "closing") return true;
  if (snap.phase === "stopping") return false;
  if (isRecoveryPending(sessionId)) return true;
  if (runner?.isBusy()) return true;
  if (turnState.has(sessionId)) return true;
  return false;
}

async function dispatchUserLine(ctx, session, text, files = [], opts = {}) {
  const { sessionManager } = ctx;
  const recordUser = opts.recordUser !== false;
  const displayText = String(text || "").trim();
  let engineText = displayText;
  const engineFiles = files;

  if (!opts.fromAutoRecovery) {
    cancelAutoRecovery(session.id);
  }

  const blocked = diagnoseSendBlocker(ctx, session.id);
  if (blocked) {
    console.error("[assistant:send]", blocked.error, blocked.detail);
    return { ok: false, error: blocked.error, detail: blocked.detail };
  }

  const { hasSendableContent } = require("./user-message");
  // For the hasSendableContent check, images in files are considered content
  if (!hasSendableContent(displayText, files)) return { ok: false, error: "EMPTY" };

  const ensured = ensureSessionRunner(ctx, session.id, {
    spawn: opts.spawnEngine === true,
  });
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

  if (opts.spawnEngine === true && !runner.isAlive()) {
    return {
      ok: false,
      error: "RUNNER_ERROR",
      detail: runner.lastSpawnError || "助手引擎进程未能启动。",
    };
  }

  const rehydrate = require("./session-bootstrap").withSessionRehydratePrefix({
    coldStart: Boolean(ensured.coldStart),
    usedResume: Boolean(ensured.usedResume),
    session,
    project: ensured.project,
    userText: engineText,
  });
  engineText = rehydrate.text;

  if (shouldQueueUserLine(session.id, runner, opts)) {
    const length = enqueueMessage(session.id, {
      text: displayText,
      files,
      displayFiles: opts.displayFiles || fileMetadataFromPayload(files),
    });
    emitQueueState(ctx, session.id);
    return { ok: true, queued: true, queueLength: length };
  }

  const phase = turnController.snapshot(session.id).phase;
  if (runner.isBusy()) {
    return { ok: false, error: "BUSY" };
  }
  if (opts.fromQueue) {
    if (phase !== "idle" && phase !== "closing") {
      return { ok: false, error: "BUSY" };
    }
  } else if (phase !== "idle") {
    return { ok: false, error: "BUSY" };
  }

  if (recordUser) {
    const fileMetadata = fileMetadataFromPayload(files);
    sessionManager.pushMessageTo(
      session.id,
      "user",
      displayText,
      fileMetadata,
    );
    if (!opts.skipSessionEvents) {
      notifyUserMessageCommitted(
        ctx,
        session.id,
        displayText,
        files,
        opts.displayFiles,
        { fromQueue: opts.fromQueue },
      );
    }
  }

  turnController.transition(session.id, "userSend");
  emitTurnState(ctx, session.id);
  const sendPreflightNotice = (payload) => {
    sendToRenderer(ctx.mainWindow, "assistant:engine-notice", {
      sessionId: session.id,
      turnId: turnController.getTurnId(session.id),
      ...payload,
    });
  };
  if (rehydrate.rehydrated) {
    sendPreflightNotice({
      code: "sessionRehydrated",
      level: "info",
      panel: true,
      replace: true,
      done: true,
    });
  }

  // Enrich images after committing the user bubble, so slow OCR/vision never makes
  // the chat appear frozen. Keep original images in the payload for vision-capable models.
  const hasImages = (files || []).some((f) => f?.isImage);
  if (hasImages) {
    sendPreflightNotice({
      code: "visionPreparing",
      level: "progress",
      panel: true,
      replace: true,
    });
    try {
      const visionResult = await require("./vision-translator").translateImages(files, {
        userText: displayText,
      });
      if (visionResult?.ok === true && visionResult.text) {
        engineText = (displayText ? `${displayText}\n\n` : "") + visionResult.text;
        sendPreflightNotice({
          code: "visionReady",
          level: "progress",
          panel: true,
          replace: true,
          replacesCode: "visionPreparing",
          done: true,
        });
      } else if (visionResult?.ok === false) {
        console.warn("[vision-translator]", visionResult.reason, visionResult.detail || "");
        sendPreflightNotice({
          code: "visionSkipped",
          level: "warning",
          panel: true,
          replace: true,
          replacesCode: "visionPreparing",
          done: true,
          detail: visionResult.detail || "",
        });
      }
    } catch (err) {
      console.warn("[vision-translator]", err.message);
      sendPreflightNotice({
        code: "visionSkipped",
        level: "warning",
        panel: true,
        replace: true,
        replacesCode: "visionPreparing",
        done: true,
        detail: err.message || "",
      });
    }
  }

  const sent = runner.sendUserMessage({ text: engineText, files: engineFiles });
  if (!sent) {
    turnController.transition(session.id, "sendFailed");
    emitTurnState(ctx, session.id);
    const spawnHint = runner.lastSpawnError;
    return {
      ok: false,
      error: "RUNNER_ERROR",
      detail: spawnHint || "助手引擎未接受消息，请重试。",
    };
  }
  require("./usage-reporter").recordUserSend(session.id, files);

  emitTurnState(ctx, session.id);

  recordTurnPayload(session.id, { text: engineText, files: engineFiles });

  const committedMeta =
    opts.displayFiles?.length > 0
      ? opts.displayFiles
      : fileMetadataFromPayload(files);
  return {
    ok: true,
    userCommitted: recordUser
      ? {
          text: displayText,
          files: committedMeta.length ? committedMeta : null,
        }
      : null,
  };
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
    if (opts.reloadSkills) {
      reloadSkillsForIdleRunners(ctx.runnerPool);
    } else {
      terminateIdleRunners(ctx.runnerPool);
    }
  } else {
    const patch = buildLiveEngineEnvPatch();
    const { failed } = applyLiveEnvToPool(ctx.runnerPool, patch);
    for (const sessionId of failed) {
      ctx.runnerPool.terminateSession(sessionId);
    }
  }

  if (opts.refreshState && ctx.agentBootstrap?.agentDefaults) {
    ctx.agentBootstrap.agentDefaults.disallowedTools =
      skillManager.getDisallowedTools();
  }
  return result;
}

module.exports = {
  sendToRenderer,
  turnState,
  emitTurnState,
  lastRunnerStderr,
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
  notifyUserMessageCommitted,
  shouldQueueUserLine,
  dispatchUserLine,
  clearMessageQueue,
  queueLength,
  emitSessionEvents,
  withRunnerChange,
};
