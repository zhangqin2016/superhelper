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

  ipcMain.handle("runtime-packs:install", async (event, payload = {}) => {
    const id = packIdFromPayload(payload);
    return require("./runtime-pack-installer").installRuntimePack(id, {
      onProgress: (progress) => {
        try {
          event.sender.send("runtime-packs:progress", progress);
        } catch {
          // Renderer progress is best-effort; installation result is returned by
          // the invoke call and must not depend on event delivery.
        }
      },
    });
  });

  ipcMain.handle("runtime-packs:uninstall", (_event, payload = {}) =>
    require("./runtime-pack-installer").uninstallRuntimePack(packIdFromPayload(payload)));
}

module.exports = { registerRuntimePackHandlers };
