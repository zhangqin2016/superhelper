"use strict";

const { ipcMain } = require("electron");
const { listPresetsPublic, setActivePreset, saveCustomPreset, deleteCustomPreset, setApiGateway } = require("./model-presets");
const { anyRunnerBusy, withRunnerChange } = require("./ipc-utils");

function registerModelHandlers(ctx) {
  ipcMain.handle("models:list", () => ({ ok: true, ...listPresetsPublic() }));

  ipcMain.handle("models:set-active", (_event, presetId) => {
    return withRunnerChange(ctx, () => {
      const r = setActivePreset(presetId);
      return r.ok ? { ok: true, ...listPresetsPublic() } : r;
    });
  });

  ipcMain.handle("models:save-custom", (_event, payload) => {
    if (anyRunnerBusy(ctx.runnerPool)) {
      return { ok: false, error: "BUSY" };
    }
    return saveCustomPreset(payload || {});
  });

  ipcMain.handle("models:delete-custom", (_event, presetId) => {
    return withRunnerChange(ctx, () => deleteCustomPreset(presetId));
  });

  ipcMain.handle("models:set-api-gateway", (_event, payload) => {
    return withRunnerChange(ctx, () => setApiGateway(payload || {}));
  });
}

function registerPermissionHandlers(ctx) {
  ipcMain.handle("permissions:list", () => ({
    ok: true,
    ...require("./permission-settings").listPermissionsPublic(),
  }));

  ipcMain.handle("permissions:set-active", (_event, modeId) => {
    return withRunnerChange(ctx, () => {
      const r = require("./permission-settings").setActivePermissionMode(modeId);
      return r.ok
        ? { ok: true, ...require("./permission-settings").listPermissionsPublic() }
        : r;
    });
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
    });
  });

  ipcMain.handle("search:set-searxng-url", (_event, url) => {
    return withRunnerChange(ctx, () => {
      const r = require("./search-settings").setSearxngUrl(url);
      return r.ok
        ? { ok: true, ...require("./search-settings").listSearchSettingsPublic() }
        : r;
    });
  });
}

module.exports = { registerModelHandlers, registerPermissionHandlers, registerSearchHandlers };
