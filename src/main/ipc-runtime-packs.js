"use strict";

const { dialog, ipcMain } = require("electron");

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
  const options = typeof payload === "object" && payload ? {
    force: Boolean(payload.force),
    repair: Boolean(payload.repair),
  } : {};
  let result;
  try {
    result = await installer.installRuntimePack(packIdFromPayload(payload), options);
  } catch (err) {
    // A rejected invoke surfaces as an opaque "Error invoking remote method"
    // in the renderer; return a structured failure instead.
    return { ok: false, error: err?.message || String(err) };
  }
  if (result?.ok) {
    result.runnerRefresh = refreshRuntimePackRunnerEnv(ctx);
  }
  return result;
}

function uninstallRuntimePackForIpc(ctx, payload = {}, deps = {}) {
  const installer = deps.installer || require("./runtime-pack-installer");
  let result;
  try {
    result = installer.uninstallRuntimePack(packIdFromPayload(payload));
  } catch (err) {
    // Same contract as install: structured failure, never an opaque
    // "Error invoking remote method".
    return { ok: false, error: err?.message || String(err) };
  }
  if (result?.ok) {
    result.runnerRefresh = refreshRuntimePackRunnerEnv(ctx);
  }
  return result;
}

function getRuntimePackLocationForIpc() {
  return require("./runtime-pack-location").getRuntimePackLocation();
}

async function chooseRuntimePackLocationForIpc(ctx = {}, payload = {}, deps = {}) {
  const picker = deps.dialog || dialog;
  const result = await picker.showOpenDialog(ctx.mainWindow, {
    title: payload?.title || "Choose dependency storage folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result?.canceled || !result?.filePaths?.[0]) {
    return { ...getRuntimePackLocationForIpc(), ok: false, canceled: true };
  }
  const changed = require("./runtime-pack-location").setRuntimePackLocation(result.filePaths[0]);
  if (changed?.ok) changed.runnerRefresh = refreshRuntimePackRunnerEnv(ctx);
  return changed;
}

function resetRuntimePackLocationForIpc(ctx = {}) {
  const result = require("./runtime-pack-location").resetRuntimePackLocation();
  if (result?.ok) result.runnerRefresh = refreshRuntimePackRunnerEnv(ctx);
  return result;
}

function registerRuntimePackHandlers(ctx = {}) {
  ipcMain.handle("runtime-packs:list", () =>
    require("./runtime-pack-installer").listRuntimePacks());

  ipcMain.handle("runtime-packs:location", () =>
    getRuntimePackLocationForIpc());

  ipcMain.handle("runtime-packs:choose-location", (_event, payload = {}) =>
    chooseRuntimePackLocationForIpc(ctx, payload));

  ipcMain.handle("runtime-packs:reset-location", () =>
    resetRuntimePackLocationForIpc(ctx));

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
  getRuntimePackLocationForIpc,
  chooseRuntimePackLocationForIpc,
  resetRuntimePackLocationForIpc,
  installRuntimePackForIpc,
  uninstallRuntimePackForIpc,
};
