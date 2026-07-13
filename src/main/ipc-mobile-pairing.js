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
    // Connect the relay to the SAME server the desktop uses for everything else,
    // so an overseas desktop (talking to the Singapore edge) relays through that
    // edge too — and lands on the same backend instance as the phone (which uses
    // the QR's base). The server-delivered LILY_MOBILE_RELAY_URL is built from the
    // static PUBLIC_BASE_URL (the China domain) and would send an abroad desktop
    // straight at China, bypassing the proxy — so prefer our own service base and
    // only fall back to the delivered env if it's somehow unavailable.
    getRelayUrl: () => {
      const apiBase = String(getServiceSettings()?.apiBaseUrl || "").trim();
      if (apiBase) return `${apiBase.replace(/^http/, "ws")}/api/mobile/relay`;
      return String(resolveSettingsEnvValue("LILY_MOBILE_RELAY_URL") || "").trim();
    },
    // Render the scannable pairing link to a QR image (main process = Node, so
    // qrcode works without a renderer bundler). Fail-open: any failure returns
    // "" and the renderer falls back to the copy-paste text code.
    makeQrImage: async (text) => {
      try {
        const QRCode = require("qrcode");
        return await QRCode.toDataURL(String(text || ""), { errorCorrectionLevel: "M", margin: 1, width: 240 });
      } catch (err) {
        log.warn("qrcode unavailable, text code only: %s", err?.message || err);
        return "";
      }
    },
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

  // Project the ACTIVE session's turn output back to the paired phone, so the
  // phone sees the reply it triggered — not just the admit ack. Passive + fully
  // fail-open: only the foreground session is projected, only when a bridge is
  // live (manager.project no-ops otherwise), and observer errors are isolated by
  // the event bus. No effect on local turns or the renderer.
  try {
    const { mobileProjectionFrame } = require("./mobile-projection");
    ctx.eventBus?.addObserver?.((sessionId, events) => {
      if (!manager.isBridged()) return;
      const activeId = ctx.sessionManager?.getActive?.()?.id;
      if (!activeId || sessionId !== activeId) return;
      for (const event of events) {
        const frame = mobileProjectionFrame(event);
        if (frame) manager.project(frame);
      }
    });
  } catch (err) {
    log.warn("mobile turn projection not wired: %s", err?.message || err);
  }

  ctx.mobilePairingManager = manager;
  return { registered: true, manager };
}

module.exports = { registerMobilePairingIpc };
