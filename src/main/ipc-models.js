"use strict";

const { ipcMain } = require("electron");
const {
  listPresetsPublic,
  setActivePreset,
  saveCustomPresetWithProbe,
  updateCustomPresetWithProbe,
  repairCustomPresetCompatibilityProfiles,
  deleteCustomPreset,
  setApiGateway,
  diagnoseAndRestoreDefaultModel,
} = require("./model-presets");
const { withRunnerChange, applyPermissionModeLive } = require("./ipc-utils");

function registerModelHandlers(ctx) {
  ipcMain.handle("models:list", async () => {
    try {
      const configRefresh = await require("./ipc-utils").refreshRemoteConfigForSend({
        force: true,
        timeoutMs: 45_000,
        repairManagedService: true,
        reason: "model_settings",
      });
      if (configRefresh?.ok) {
        require("./runner-live-config").terminateIdleRunners(ctx.runnerPool);
      }
    } catch {
      // Settings must still open offline or when the service is unavailable.
      // listPresetsPublic() may use the last valid signed cache and local
      // custom presets, but never packaged defaults for service-managed models.
    }
    try {
      const repaired = await repairCustomPresetCompatibilityProfiles({ activeOnly: true, timeoutMs: 15_000 });
      if (repaired?.repairedCount) {
        require("./runner-live-config").terminateIdleRunners(ctx.runnerPool);
      }
    } catch {
      // Model settings should still render; failed custom-profile repair is
      // surfaced by save/send preflight paths instead of blocking the panel.
    }
    return { ok: true, ...listPresetsPublic() };
  });

  ipcMain.handle("models:set-active", async (_event, presetId) => {
    return withRunnerChange(ctx, async () => {
      const r = setActivePreset(presetId);
      if (!r.ok) return r;
      await repairCustomPresetCompatibilityProfiles({ activeOnly: true, timeoutMs: 15_000 });
      return { ok: true, ...listPresetsPublic() };
    }, { liveEnv: false });
  });

  ipcMain.handle("models:save-custom", (_event, payload) => {
    return withRunnerChange(ctx, () => saveCustomPresetWithProbe(payload || {}), { liveEnv: false });
  });

  ipcMain.handle("models:update-custom", (_event, payload) => {
    return withRunnerChange(ctx, () => updateCustomPresetWithProbe(payload?.presetId, payload?.values || {}), { liveEnv: false });
  });

  ipcMain.handle("models:delete-custom", (_event, presetId) => {
    return withRunnerChange(ctx, () => deleteCustomPreset(presetId), { liveEnv: false });
  });

  ipcMain.handle("models:set-api-gateway", (_event, payload) => {
    return withRunnerChange(ctx, () => setApiGateway(payload || {}), { liveEnv: false });
  });

  ipcMain.handle("models:diagnose-restore-default", async () => {
    return withRunnerChange(ctx, async () => {
      let configRefresh = null;
      try {
        configRefresh = await require("./ipc-utils").refreshRemoteConfigForSend({
          force: true,
          timeoutMs: 45_000,
          repairManagedService: true,
          refreshLicense: false,
          reason: "model_diagnose_restore",
        });
      } catch (err) {
        configRefresh = { ok: false, error: err?.message || String(err) };
      }
      const restored = diagnoseAndRestoreDefaultModel();
      return {
        ...restored,
        modelConfigReady: Boolean(configRefresh?.ok),
        modelConfigError: configRefresh?.ok ? "" : String(configRefresh?.error || "CONFIG_REFRESH_FAILED"),
      };
    }, { liveEnv: false });
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
