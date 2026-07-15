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

// Build the controlled session's context frame for the phone:
// title + live phase/queue + recent conversation. Fail-open to null.
function buildSessionContext(ctx, sessionId = "") {
  try {
    const { buildSessionContextFrame } = require("./mobile-projection");
    const active = sessionId
      ? ctx.sessionManager?.findById?.(sessionId)
      : ctx.sessionManager?.getActive?.();
    if (!active?.id) return null;
    let recent = [];
    try { recent = ctx.sessionManager.getProjectedConversation(active.id, { limit: 12 }) || []; } catch { /* best effort */ }
    let snap = {};
    try { snap = ctx.turnOrchestrator.snapshot(active.id) || {}; } catch { /* best effort */ }
    return buildSessionContextFrame({
      title: active.title || "",
      sessionId: active.id,
      phase: snap.phase || "",
      queueLength: snap.queueLength || 0,
      recent: recent.map((m) => ({ role: m.role, text: m.content })),
    });
  } catch {
    return null;
  }
}

function buildActiveSessionContext(ctx) {
  return buildSessionContext(ctx);
}

function registerMobilePairingIpc(ctx) {
  if (process.env.LILY_MOBILE_COMMAND === "0") return { registered: false };
  const { ipcMain } = require("electron");
  const { serviceFetch, getDeviceId, getServiceSettings } = require("./service-client");
  const accountManager = require("./account-manager");
  const { resolveSettingsEnvValue } = require("./agent-settings");
  const { createMobilePairingManager } = require("./mobile-pairing-manager");
  const { createMobileAgentBridge } = require("./mobile-agent-bridge");
  const log = require("./logger").getLogger("mobile-pairing");
  let selectedMobileSessionId = "";

  function currentProjectId() {
    try { return ctx.projectManager?.getActive?.()?.id || ""; } catch { return ""; }
  }

  function mobileTargetSessionId() {
    const selected = selectedMobileSessionId ? ctx.sessionManager?.findById?.(selectedMobileSessionId) : null;
    if (selected?.id && (!currentProjectId() || selected.projectId === currentProjectId())) return selected.id;
    selectedMobileSessionId = "";
    return ctx.sessionManager?.getActive?.()?.id || "";
  }

  function buildMobileSessionList() {
    const projectId = currentProjectId();
    const sessions = projectId ? (ctx.sessionManager?.listForProject?.(projectId) || []) : [];
    const activeSessionId = ctx.sessionManager?.activeSessionId || ctx.sessionManager?.getActive?.()?.id || "";
    const selectedSessionId = mobileTargetSessionId();
    return {
      type: "sessions.list",
      activeSessionId,
      selectedSessionId,
      sessions: sessions.map((session) => ({
        id: String(session.id || ""),
        title: String(session.title || "当前会话"),
        updatedAt: session.updatedAt || "",
        messageCount: Number.isInteger(session.messageCount) ? session.messageCount : 0,
      })).filter((session) => session.id),
    };
  }

  function selectMobileSession(sessionId) {
    const target = ctx.sessionManager?.findById?.(sessionId);
    if (!target?.id || (currentProjectId() && target.projectId !== currentProjectId())) return null;
    selectedMobileSessionId = target.id;
    return buildSessionContext(ctx, target.id);
  }

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
        // Phase 1 default remains the desktop's foreground session. When the
        // phone explicitly selected a session from the current project, honor
        // that target without changing the desktop UI's active session.
        let lilySessionId = envelope.lilySessionId || mobileTargetSessionId();
        try {
          const target = lilySessionId ? ctx.sessionManager?.findById?.(lilySessionId) : null;
          if (!target?.id || (currentProjectId() && target.projectId !== currentProjectId())) {
            lilySessionId = ctx.sessionManager?.getActive?.()?.id || "";
          }
        } catch { /* fall back to the envelope's target */ }
        return ctx.turnOrchestrator.admitExternalCommand({ ...envelope, lilySessionId });
      },
      // Mobile "stop": interrupt the running turn in the foreground session via
      // the controlled seam (keeps the queue; only the current turn stops).
      interrupt: () => {
        try {
          const active = ctx.sessionManager?.getActive?.();
          if (!active?.id) return { ok: false, code: "NO_ACTIVE_SESSION" };
          return ctx.turnOrchestrator.interrupt(active.id, { clearQueue: false });
        } catch (err) {
          log.warn("mobile interrupt failed: %s", err?.message || err);
          return { ok: false, code: "INTERRUPT_ERROR" };
        }
      },
      getSessionContext: () => buildSessionContext(ctx, mobileTargetSessionId()),
      getSessionList: () => buildMobileSessionList(),
      selectSession: (sessionId) => selectMobileSession(String(sessionId || "")),
      // Write phone-sent attachments to a temp dir under userData; the turn gets
      // real paths. Fail-open to [] (command runs text-only).
      materializeAttachments: (attachments) => {
        try {
          const { materializeMobileAttachments } = require("./mobile-attachments");
          const { userDataPath } = require("./config");
          return materializeMobileAttachments(attachments, {
            tmpDir: userDataPath("mobile-command-attachments"),
            stamp: String(Date.now()),
          });
        } catch (err) {
          log.warn("mobile attachment materialize failed: %s", err?.message || err);
          return [];
        }
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
  ipcMain.handle("mobile-pairing:create-direct-code", guard(() => manager.createDirectCode()));
  ipcMain.handle("mobile-pairing:poll-pending", guard(() => manager.pollPending()));
  ipcMain.handle("mobile-pairing:list-devices", guard(() => manager.listDevices()));
  ipcMain.handle("mobile-pairing:approve", guard((_e, grantId) => manager.approve(String(grantId || ""))));
  ipcMain.handle("mobile-pairing:deny", guard((_e, grantId) => manager.deny(String(grantId || ""))));
  ipcMain.handle("mobile-pairing:revoke", guard((_e, payload = {}) => manager.revoke(String(payload.grantId || ""), payload.reason)));
  ipcMain.handle("mobile-pairing:status", guard(() => manager.status()));

  // Project the ACTIVE session's turn output back to the paired phone, so the
  // phone sees the reply it triggered — not just the admit ack. Passive + fully
  // fail-open: only the foreground session is projected, only when a bridge is
  // live (manager.project no-ops otherwise), and observer errors are isolated by
  // the event bus. No effect on local turns or the renderer.
  try {
    const { mobileProjectionFrame } = require("./mobile-projection");
    ctx.eventBus?.addObserver?.((sessionId, events) => {
      if (!manager.isBridged()) return;
      const targetId = mobileTargetSessionId();
      if (!targetId || sessionId !== targetId) return;
      let turnEnded = false;
      for (const event of events) {
        const frame = mobileProjectionFrame(event);
        if (frame) { manager.project(frame); if (frame.type === "turn.ended") turnEnded = true; }
      }
      // After a turn settles, refresh the phone's session context (recent
      // history now includes this turn's result).
      if (turnEnded) {
        const context = buildSessionContext(ctx, targetId);
        if (context) manager.project(context);
      }
    });
  } catch (err) {
    log.warn("mobile turn projection not wired: %s", err?.message || err);
  }

  ctx.mobilePairingManager = manager;
  return { registered: true, manager };
}

module.exports = { registerMobilePairingIpc };
