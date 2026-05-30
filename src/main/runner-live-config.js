"use strict";

const { getActivePresetEnv, getUserApiEnv } = require("./model-presets");
const { getSearchSpawnEnv } = require("./search-settings");
const { normalizeToLilyEnv, toEngineEnv } = require("./agent-env");

function buildLiveEngineEnvPatch() {
  const { loadSettingsEnv } = require("./agent-settings");
  const lilyEnv = normalizeToLilyEnv({
    ...loadSettingsEnv(),
    ...getUserApiEnv(),
    ...getActivePresetEnv(),
  });
  return {
    ...toEngineEnv(lilyEnv),
    ...getSearchSpawnEnv(),
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
  for (const sessionId of [...runnerPool.getSessionIds()]) {
    const runner = runnerPool.get(sessionId);
    if (runner?.isAlive() && !runner.isBusy()) {
      runnerPool.terminateSession(sessionId);
    }
  }
}

module.exports = {
  buildLiveEngineEnvPatch,
  applyLiveEnvToPool,
  terminateIdleRunners,
};
