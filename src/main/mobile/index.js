"use strict";

/**
 * Mobile Command — composition root.
 *
 *   control-channel  ── events ──▶ phone-directory ── state ──▶ renderer (pushed)
 *        │  ▲                            │
 *        │  └──── send(grantId, frame) ──┼── phone-controller (one per phone)
 *        └── phone frames ──────────────▶┘         │
 *                                                  ▼
 *   session-mirror ◀── runtime events ── desktop-port ──▶ orchestrator / sessions
 *
 * Wiring only. Every decision lives in the module that owns it; this file
 * builds them, connects them, and exposes the user's pairing actions over IPC.
 * Kill switch: LILY_MOBILE_COMMAND=0 registers nothing.
 */

const { createControlChannel } = require("./control-channel");
const { createDesktopPort } = require("./desktop-port");
const { createPairingApi } = require("./pairing-api");
const { createPhoneController } = require("./phone-controller");
const { createPhoneDirectory } = require("./phone-directory");
const { createSessionMirror } = require("./session-mirror");
const { CONTROL_PROTOCOL } = require("./protocol");

const RELAY_PATH = "/api/mobile/relay";
const MAX_EXPIRY_WAIT_MS = 60 * 60 * 1000;

function registerMobileCommand(ctx, deps = {}) {
  if (process.env.LILY_MOBILE_COMMAND === "0") return { registered: false };
  const { ipcMain } = deps.electron || require("electron");
  const serviceClient = deps.serviceClient || require("./../service-client");
  const accountManager = deps.accountManager || require("./../account-manager");
  const log = deps.log || require("./../logger").getLogger("mobile-command");
  const WebSocketCtor = deps.WebSocketCtor || globalThis.WebSocket;

  const serviceBase = () => String(serviceClient.getServiceSettings()?.apiBaseUrl || "").trim().replace(/\/+$/, "");
  const accountToken = () => accountManager.accessTokenForService();
  const desktopDeviceId = () => serviceClient.getDeviceId();

  const port = deps.port || createDesktopPort(ctx, {
    tmpDir: require("./../config").userDataPath("mobile-command-attachments"),
    log,
  });
  const api = createPairingApi({
    serviceFetch: serviceClient.serviceFetch,
    getAccountToken: accountToken,
    getDesktopDeviceId: desktopDeviceId,
    getServerBaseUrl: serviceBase,
    makeQrImage: deps.makeQrImage || (async (text) => require("qrcode").toDataURL(String(text), { errorCorrectionLevel: "M", margin: 1, width: 320 })),
    log,
  });
  const directory = createPhoneDirectory();
  const controllers = new Map(); // grantId -> phone controller
  let capabilities = null;

  // The relay of the SAME server the desktop uses for everything else, so an
  // overseas desktop relays through its edge and meets the phone (which uses
  // the QR's base) on the same backend.
  const channel = createControlChannel({
    getUrl: () => (serviceBase() ? `${serviceBase().replace(/^http/, "ws")}${RELAY_PATH}` : ""),
    getToken: async () => {
      const result = await accountToken();
      return result?.ok ? result.accessToken : "";
    },
    getDeviceId: desktopDeviceId,
    WebSocketCtor,
    log,
    onEvent: (event) => {
      if (event.type === "phone-frame") {
        void controllers.get(event.grantId)?.handle(event.frame);
        return;
      }
      directory.apply(event);
      syncControllers();
    },
  });

  const mirror = createSessionMirror({
    port,
    controllers: () => controllers.values(),
    send: (grantId, frame) => channel.send(grantId, frame),
    log,
  });

  // One controller per paired phone, exactly the directory's phones.
  function syncControllers() {
    const live = new Set(directory.grantIds());
    for (const grantId of controllers.keys()) if (!live.has(grantId)) controllers.delete(grantId);
    for (const grantId of live) {
      if (controllers.has(grantId)) continue;
      controllers.set(grantId, createPhoneController({
        grantId,
        getDesktopDeviceId: desktopDeviceId,
        port,
        snapshot: mirror.snapshot,
        send: (frame) => channel.send(grantId, frame),
        log,
      }));
    }
  }

  // --- renderer state: pushed on every change ---------------------------------
  let expiryTimer = null;
  function state() {
    return { ok: true, ...directory.snapshot(), capabilities };
  }
  function pushState() {
    try { ctx.mainWindow?.webContents?.send?.("mobile:state", state()); } catch { /* window may be gone */ }
    // A pending request lapses without an event; re-render when it does.
    // Capped: a far expiry is re-evaluated hourly rather than overflowing the
    // 32-bit timer (which Node clamps to 1ms — a push storm).
    clearTimeout(expiryTimer);
    const next = directory.nextExpiry();
    if (next) {
      expiryTimer = setTimeout(pushState, Math.min(MAX_EXPIRY_WAIT_MS, Math.max(500, next - Date.now() + 50)));
      expiryTimer.unref?.();
    }
  }
  directory.subscribe(pushState);

  // --- start: only against a server that speaks the control channel ----------
  async function start() {
    const caps = await api.capabilities().catch(() => ({ ok: false }));
    if (caps.ok) capabilities = caps.capabilities;
    if (caps.ok && caps.controlChannel < CONTROL_PROTOCOL) {
      // Say so, instead of a channel that never connects.
      directory.apply({ type: "status", status: "server-outdated" });
      return;
    }
    mirror.start();
    channel.start();
  }

  const guard = (fn) => async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      log.warn("mobile ipc failed: %s", err?.message || err);
      return { ok: false, code: "MOBILE_IPC_ERROR" };
    }
  };

  ipcMain.handle("mobile:get-state", guard(async () => {
    // Opening the page after signing in should not wait for the next retry.
    channel.kick();
    return state();
  }));
  ipcMain.handle("mobile:create-challenge", guard(() => api.createChallenge()));
  ipcMain.handle("mobile:create-direct-code", guard(() => api.createDirectCode()));
  ipcMain.handle("mobile:approve", guard((_e, grantId) => api.approve(String(grantId || ""))));
  ipcMain.handle("mobile:deny", guard((_e, grantId) => api.deny(String(grantId || ""))));
  ipcMain.handle("mobile:revoke", guard((_e, grantId) => api.revoke(String(grantId || ""))));

  void start();

  const runtime = {
    registered: true,
    state,
    stop() {
      channel.stop();
      mirror.stop();
      clearTimeout(expiryTimer);
    },
  };
  ctx.mobileCommand = runtime;
  return runtime;
}

module.exports = { registerMobileCommand };
