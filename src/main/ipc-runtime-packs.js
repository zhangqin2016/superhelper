"use strict";

const { ipcMain } = require("electron");

function packIdFromPayload(payload) {
  return typeof payload === "string" ? payload : payload?.id || payload?.packId || "";
}

function registerRuntimePackHandlers() {
  ipcMain.handle("runtime-packs:list", () =>
    require("./runtime-pack-installer").listRuntimePacks());

  ipcMain.handle("runtime-packs:health", (_event, payload = {}) =>
    require("./runtime-health").checkDependencyHealth(packIdFromPayload(payload)));

  ipcMain.handle("runtime-packs:availability", (_event, payload = {}) =>
    require("./runtime-pack-installer").checkRuntimePackAvailability(payload?.ids || payload?.packIds || []));

  ipcMain.handle("runtime-packs:preflight", (_event, payload = {}) =>
    require("./runtime-pack-preflight").preflightRuntimePacks(payload));

  ipcMain.handle("runtime-packs:install", async (_event, payload = {}) =>
    require("./runtime-pack-installer").installRuntimePack(packIdFromPayload(payload)));

  ipcMain.handle("runtime-packs:uninstall", (_event, payload = {}) =>
    require("./runtime-pack-installer").uninstallRuntimePack(packIdFromPayload(payload)));
}

module.exports = { registerRuntimePackHandlers };
