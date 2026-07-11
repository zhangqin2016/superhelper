"use strict";

function uniquePackIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function defaultInstalledPackIds() {
  const installer = require("./runtime-pack-installer");
  const installed = new Set(installer.installedRuntimePackIds());
  for (const id of installer.baseProvidedRuntimePackMap().keys()) installed.add(id);
  return installed;
}

function createRuntimePackCoordinator(options = {}) {
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent) || 2);
  const installer = options.installer || ((id, installOptions) =>
    require("./runtime-pack-installer").installRuntimePack(id, installOptions));
  const health = options.health || ((id) => require("./runtime-health").checkRuntimePackHealth(id));
  const installedPackIds = options.installedPackIds || defaultInstalledPackIds;
  const jobsByPackId = new Map();
  const queue = [];
  let active = 0;

  function drain() {
    while (active < maxConcurrent && queue.length) {
      const item = queue.shift();
      active += 1;
      Promise.resolve()
        .then(item.run)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  function schedule(run) {
    return new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
      drain();
    });
  }

  function preparePack(id, turnId, onProgress) {
    const existing = jobsByPackId.get(id);
    if (existing) return existing;
    const promise = schedule(async () => {
      let result;
      try {
        result = await installer(id, { turnId, onProgress });
      } catch (error) {
        result = { ok: false, id, error: error?.message || String(error) };
      }
      if (!result?.ok) return { id, ok: false, error: result?.error || "RUNTIME_PACK_INSTALL_FAILED" };
      let healthResult;
      try {
        healthResult = await health(id);
      } catch (error) {
        healthResult = { ok: false, error: error?.message || String(error) };
      }
      if (!healthResult?.ok) {
        return { id, ok: false, error: "RUNTIME_PACK_HEALTH_FAILED", health: healthResult };
      }
      return { id, ok: true, installed: !result.skipped, result, health: healthResult };
    });
    jobsByPackId.set(id, promise);
    const cleanup = () => {
      if (jobsByPackId.get(id) === promise) jobsByPackId.delete(id);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  async function prepare({ turnId = "", requiredPackIds = [], onProgress } = {}) {
    const ids = uniquePackIds(requiredPackIds);
    const installed = installedPackIds();
    const initial = installed instanceof Set ? installed : new Set(installed || []);
    const results = await Promise.all(ids.map((id) => initial.has(id)
      ? Promise.resolve({ id, ok: true, installed: false, skipped: true })
      : preparePack(id, turnId, onProgress)));
    const failures = results.filter((result) => !result.ok);
    const unavailablePackIds = failures
      .filter((result) => result.error === "NO_RUNTIME_PACK_ARTIFACT")
      .map((result) => result.id);
    const unavailable = new Set(unavailablePackIds);
    return {
      ok: failures.length === 0,
      turnId,
      readyPackIds: results.filter((result) => result.ok).map((result) => result.id),
      installedPackIds: results.filter((result) => result.ok && result.installed).map((result) => result.id),
      failedPackIds: failures.filter((result) => !unavailable.has(result.id)).map((result) => result.id),
      unavailablePackIds,
      refreshRequired: results.some((result) => result.ok && result.installed),
      failures: failures.map(({ id, error, health: healthResult }) => ({ id, error, health: healthResult })),
    };
  }

  return { prepare };
}

const runtimePackCoordinator = createRuntimePackCoordinator();

module.exports = {
  createRuntimePackCoordinator,
  runtimePackCoordinator,
};
