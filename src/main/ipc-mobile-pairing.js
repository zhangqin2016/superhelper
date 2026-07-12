"use strict";

/**
 * Mobile Command pairing — main-process IPC wiring.
 *
 * Instantiates the desktop pairing manager with the real signed service client,
 * account token, and an agent-bridge factory whose admit path lands mobile
 * commands in the CURRENTLY ACTIVE Lily session via the sanctioned
 * TurnOrchestrator.admitExternalCommand seam (never sendUserMessage). Exposes
 * the pairing operations to the renderer over IPC.
 *
 * Additive + kill-switched (LILY_MOBILE_COMMAND=0): registers nothing when off,
 * so the desktop behaves exactly as before.
 */

function registerMobilePairingIpc(ctx) {
  if (process.env.LILY_MOBILE_COMMAND === "0") return { registered: false };
  const { ipcMain } = require("electron");
  const { serviceFetch, getDeviceId, getServiceSettings } = require("./service-client");
  const accountManager = require("./account-manager");
  const { resolveSettingsEnvValue } = require("./agent-settings");
  const { createMobilePairingManager } = require("./mobile-pairing-manager");
  const { createMobileAgentBridge } = require("./mobile-agent-bridge");
  const log = require("./logger").getLogger("mobile-pairing");

  const manager = createMobilePairingManager({
    serviceFetch,
    getAccountToken: () => accountManager.accessTokenForService(),
    getDesktopDeviceId: () => getDeviceId(),
    getServerBaseUrl: () => getServiceSettings()?.apiBaseUrl || "",
    // Delivered by the server in gateway mode (mirrors LILY_ASR_RELAY_URL).
    getRelayUrl: () => String(resolveSettingsEnvValue("LILY_MOBILE_RELAY_URL") || "").trim(),
    startBridge: (opts) => createMobileAgentBridge({
      ...opts,
      log,
      admit: (envelope) => {
        // Phase 1 target selection: a mobile command lands in whatever Lily
        // session is active on the desktop right now (contract §3.1 MVP).
        let lilySessionId = envelope.lilySessionId;
        try {
          const active = ctx.sessionManager?.getActive?.();
          if (active?.id) lilySessionId = active.id;
        } catch { /* fall back to the envelope's target */ }
        return ctx.turnOrchestrator.admitExternalCommand({ ...envelope, lilySessionId });
      },
    }),
    log,
  });

  const guard = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      log.warn("mobile pairing ipc failed: %s", err?.message || err);
      return { ok: false, code: "MOBILE_PAIRING_IPC_ERROR" };
    }
  };

  ipcMain.handle("mobile-pairing:create-challenge", guard(() => manager.createChallenge()));
  ipcMain.handle("mobile-pairing:poll-pending", guard(() => manager.pollPending()));
  ipcMain.handle("mobile-pairing:approve", guard((_e, grantId) => manager.approve(String(grantId || ""))));
  ipcMain.handle("mobile-pairing:deny", guard((_e, grantId) => manager.deny(String(grantId || ""))));
  ipcMain.handle("mobile-pairing:revoke", guard((_e, payload = {}) => manager.revoke(String(payload.grantId || ""), payload.reason)));
  ipcMain.handle("mobile-pairing:status", guard(() => ({ ok: true, bridged: manager.isBridged() })));

  ctx.mobilePairingManager = manager;
  return { registered: true, manager };
}

module.exports = { registerMobilePairingIpc };
