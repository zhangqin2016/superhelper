"use strict";

const { ipcMain } = require("electron");
const { listPresetsPublic, setActivePreset, saveCustomPreset, deleteCustomPreset, setApiGateway } = require("./model-presets");
const { withRunnerChange, applyPermissionModeLive } = require("./ipc-utils");

function registerModelHandlers(ctx) {
  ipcMain.handle("models:list", async () => {
    try {
      await require("./remote-config").refreshRemoteConfig({ reason: "model_settings" });
    } catch {
      // Settings must still open offline or when the service is unavailable.
      // listPresetsPublic() will use the last valid cache or packaged defaults.
    }
    return { ok: true, ...listPresetsPublic() };
  });

  ipcMain.handle("models:set-active", (_event, presetId) => {
    return withRunnerChange(ctx, () => {
      const r = setActivePreset(presetId);
      return r.ok ? { ok: true, ...listPresetsPublic() } : r;
    }, { liveEnv: false });
  });

  ipcMain.handle("models:save-custom", (_event, payload) => {
    return withRunnerChange(ctx, () => saveCustomPreset(payload || {}), { liveEnv: false });
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

function registerMediaProviderHandlers(ctx) {
  const settings = () => require("./media-provider-settings");
  ipcMain.handle("media-providers:list", () => ({ ok: true, ...settings().listMediaProvidersPublic() }));

  ipcMain.handle("media-providers:set-choice", (_event, payload) => {
    return withRunnerChange(ctx, () => {
      const r = settings().setModalityChoice(payload?.modality, payload?.source, payload?.provider);
      return r.ok ? { ok: true, ...settings().listMediaProvidersPublic() } : r;
    });
  });

  ipcMain.handle("media-providers:set-key", (_event, payload) => {
    return withRunnerChange(ctx, () => {
      const r = settings().setProviderKey(payload?.provider, payload?.values || {});
      return r.ok ? { ok: true, ...settings().listMediaProvidersPublic() } : r;
    });
  });
}

module.exports = {
  registerModelHandlers,
  registerPermissionHandlers,
  registerSearchHandlers,
  registerMediaProviderHandlers,
};
