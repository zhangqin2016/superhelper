"use strict";

const { ipcMain } = require("electron");

function packIdFromPayload(payload) {
  return typeof payload === "string" ? payload : payload?.id || payload?.packId || "";
}

function refreshRuntimePackRunnerEnv(ctx = {}) {
  if (!ctx?.runnerPool) return { terminated: [] };
  try {
    return require("./runner-live-config").terminateIdleRunners(ctx.runnerPool);
  } catch (err) {
    return { terminated: [], error: err?.message || String(err) };
  }
}

async function installRuntimePackForIpc(ctx, payload = {}, deps = {}) {
  const installer = deps.installer || require("./runtime-pack-installer");
  const result = await installer.installRuntimePack(packIdFromPayload(payload));
  if (result?.ok) {
    result.runnerRefresh = refreshRuntimePackRunnerEnv(ctx);
  }
  return result;
}

function uninstallRuntimePackForIpc(ctx, payload = {}, deps = {}) {
  const installer = deps.installer || require("./runtime-pack-installer");
  const result = installer.uninstallRuntimePack(packIdFromPayload(payload));
  if (result?.ok) {
    result.runnerRefresh = refreshRuntimePackRunnerEnv(ctx);
  }
  return result;
}

function registerRuntimePackHandlers(ctx = {}) {
  ipcMain.handle("runtime-packs:list", () =>
    require("./runtime-pack-installer").listRuntimePacks());

  ipcMain.handle("runtime-packs:health", (_event, payload = {}) =>
    require("./runtime-health").checkDependencyHealth(packIdFromPayload(payload)));

  ipcMain.handle("runtime-packs:availability", (_event, payload = {}) =>
    require("./runtime-pack-installer").checkRuntimePackAvailability(payload?.ids || payload?.packIds || []));

  ipcMain.handle("runtime-packs:preflight", (_event, payload = {}) =>
    require("./runtime-pack-preflight").preflightRuntimePacks(payload));

  ipcMain.handle("runtime-packs:install", async (_event, payload = {}) =>
    installRuntimePackForIpc(ctx, payload));

  ipcMain.handle("runtime-packs:uninstall", (_event, payload = {}) =>
    uninstallRuntimePackForIpc(ctx, payload));
}

module.exports = {
  registerRuntimePackHandlers,
  refreshRuntimePackRunnerEnv,
  installRuntimePackForIpc,
  uninstallRuntimePackForIpc,
};
