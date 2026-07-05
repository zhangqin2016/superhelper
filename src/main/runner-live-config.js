"use strict";

const { getActivePresetEnv, getUserApiEnv } = require("./model-presets");
const { getSearchSpawnEnv } = require("./search-settings");
const { getMediaProviderSpawnEnv } = require("./media-provider-settings");
const { normalizeToLilyEnv, toEngineEnv } = require("./agent-env");

function buildLiveEngineEnvPatch() {
  const { loadSettingsEnv } = require("./agent-settings");
  const lilyEnv = normalizeToLilyEnv({
    ...loadSettingsEnv(),
    ...require("./remote-config").getRemoteRuntimeEnvSync(),
    ...getUserApiEnv(),
    ...getActivePresetEnv(),
  });
  return {
    ...toEngineEnv(lilyEnv),
    ...getSearchSpawnEnv(),
    ...getMediaProviderSpawnEnv(),
  };
}

/**
 * @param {import("./session-runner-pool").SessionRunnerPool} runnerPool
 * @param {Record<string, string>} envPatch
 */
function applyLiveEnvToPool(runnerPool, envPatch) {
  /** @type {string[]} */
  const applied = [];
  /** @type {string[]} */
  const failed = [];
  for (const sessionId of runnerPool.getSessionIds()) {
    const runner = runnerPool.get(sessionId);
    if (!runner?.isAlive()) continue;
    if (runner.updateEnvironmentVariables(envPatch)) {
      applied.push(sessionId);
    } else {
      failed.push(sessionId);
    }
  }
  return { applied, failed };
}

/**
 * @param {import("./session-runner-pool").SessionRunnerPool} runnerPool
 */
function terminateIdleRunners(runnerPool) {
  /** @type {string[]} */
  const terminated = [];
  for (const sessionId of [...runnerPool.getSessionIds()]) {
    const runner = runnerPool.get(sessionId);
    if (runner?.isAlive() && !runner.isBusy()) {
      runnerPool.terminateSession(sessionId);
      terminated.push(sessionId);
    }
  }
  return { terminated };
}

/**
 * @param {import("./session-runner-pool").SessionRunnerPool} runnerPool
 */
function reloadSkillsForIdleRunners(runnerPool) {
  /** @type {string[]} */
  const reloaded = [];
  /** @type {string[]} */
  const restarted = [];
  for (const sessionId of [...runnerPool.getSessionIds()]) {
    const runner = runnerPool.get(sessionId);
    if (!runner?.isAlive() || runner.isBusy()) continue;
    if (runner.reloadSkills()) {
      reloaded.push(sessionId);
    } else {
      runnerPool.terminateSession(sessionId);
      restarted.push(sessionId);
    }
  }
  return { reloaded, restarted };
}

module.exports = {
  buildLiveEngineEnvPatch,
  applyLiveEnvToPool,
  terminateIdleRunners,
  reloadSkillsForIdleRunners,
};
