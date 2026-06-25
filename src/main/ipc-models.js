"use strict";

const { ipcMain } = require("electron");
const { listPresetsPublic, setActivePreset, saveCustomPreset, deleteCustomPreset, setApiGateway } = require("./model-presets");
const { anyRunnerBusy, withRunnerChange, applyPermissionModeLive } = require("./ipc-utils");

function registerModelHandlers(ctx) {
  ipcMain.handle("models:list", () => ({ ok: true, ...listPresetsPublic() }));

  ipcMain.handle("models:set-active", (_event, presetId) => {
    return withRunnerChange(ctx, () => {
      const r = setActivePreset(presetId);
      return r.ok ? { ok: true, ...listPresetsPublic() } : r;
    }, { liveEnv: false });
  });

  ipcMain.handle("models:save-custom", (_event, payload) => {
    if (anyRunnerBusy(ctx.runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    return saveCustomPreset(payload || {});
  });

  ipcMain.handle("models:delete-custom", (_event, presetId) => {
    return withRunnerChange(ctx, () => deleteCustomPreset(presetId), { liveEnv: false });
  });

  ipcMain.handle("models:set-api-gateway", (_event, payload) => {
    return withRunnerChange(ctx, () => setApiGateway(payload || {}), { liveEnv: false });
  });

  ipcMain.handle("engine:list", () => ({
    ok: true,
    ...require("./engine-settings").listEnginesPublic(),
  }));

  // Switching engine requires fresh runners (different runner class), so route
  // it through withRunnerChange: rejected while busy, idle runners torn down.
  ipcMain.handle("engine:set-active", (_event, engineId) => {
    return withRunnerChange(ctx, () => {
      const r = require("./engine-settings").setEngine(engineId);
      return r.ok ? { ok: true, ...require("./engine-settings").listEnginesPublic() } : r;
    }, { liveEnv: false });
  });
}

function registerPermissionHandlers(ctx) {
  ipcMain.handle("permissions:list", () => ({
    ok: true,
    ...require("./permission-settings").listPermissionsPublic(),
  }));

  ipcMain.handle("permissions:set-active", (_event, modeId) => {
    return applyPermissionModeLive(ctx, modeId);
  });
}

function registerSearchHandlers(ctx) {
  ipcMain.handle("search:list", () => ({
    ok: true,
    ...require("./search-settings").listSearchSettingsPublic(),
  }));

  ipcMain.handle("search:set-provider", (_event, providerId) => {
    return withRunnerChange(ctx, () => {
      const r = require("./search-settings").setSearchProvider(providerId);
      return r.ok
        ? { ok: true, ...require("./search-settings").listSearchSettingsPublic() }
        : r;
    }, { liveEnv: false });
  });

  ipcMain.handle("search:set-searxng-url", (_event, url) => {
    return withRunnerChange(ctx, () => {
      const r = require("./search-settings").setSearxngUrl(url);
      return r.ok
        ? { ok: true, ...require("./search-settings").listSearchSettingsPublic() }
        : r;
    }, { liveEnv: false });
  });
}

module.exports = { registerModelHandlers, registerPermissionHandlers, registerSearchHandlers };
