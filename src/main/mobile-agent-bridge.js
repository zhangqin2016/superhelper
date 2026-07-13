"use strict";

/**
 * Desktop agent bridge for Mobile Command (Phase 1 text channel).
 *
 * The desktop connects to the server WS relay as role=desktop for an active
 * pairing grant. When the paired mobile sends a command frame, the bridge
 * builds the semantic envelope and admits it through the ONLY sanctioned seam
 * (TurnOrchestrator.admitExternalCommand) — never sendUserMessage/runner. The
 * admission result is projected back to mobile as an ack frame.
 *
 * The frame→admit→projection decision is pure (handleRelayCommandFrame) and
 * unit-tested; the WS client lifecycle (connect/reconnect) is the thin glue.
 */

const crypto = require("node:crypto");

const MAX_COMMAND_TEXT = 8000;

function payloadHashFor(text, attachments) {
  const canonical = JSON.stringify({ text: String(text || ""), attachments: attachments || [] });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Turn a raw relay frame from mobile into an admission + a projection frame to
 * send back. Pure: `admit(envelope)` is injected (the orchestrator seam).
 *
 * @returns {Promise<{reply: object|null}>} reply is the frame to send to mobile
 *   (or null when the frame is not a command we handle).
 */
async function handleRelayCommandFrame(rawFrame, { admit, interrupt, desktopDeviceId = "", lilySessionId = "" } = {}) {
  let frame;
  try {
    frame = typeof rawFrame === "string" ? JSON.parse(rawFrame) : rawFrame;
  } catch {
    return { reply: { type: "relay.error", code: "COMMAND_FRAME_MALFORMED" } };
  }
  if (!frame) return { reply: null };

  // Mobile "stop": interrupt the running turn through the controlled seam
  // (never the runner directly). Fail-open — a failed interrupt just acks false.
  if (frame.type === "interrupt") {
    if (typeof interrupt !== "function") return { reply: { type: "interrupt.ack", ok: false, code: "INTERRUPT_UNAVAILABLE" } };
    try {
      const r = await interrupt({ turnId: String(frame.turnId || "") });
      return { reply: { type: "interrupt.ack", ok: Boolean(r?.ok ?? true), turnId: frame.turnId || null } };
    } catch (err) {
      return { reply: { type: "interrupt.ack", ok: false, code: "INTERRUPT_ERROR", detail: String(err?.message || err) } };
    }
  }

  if (frame.type !== "command") return { reply: null };

  const text = String(frame.text || "").slice(0, MAX_COMMAND_TEXT);
  const attachments = Array.isArray(frame.attachments) ? frame.attachments : [];
  const targetSession = String(frame.lilySessionId || lilySessionId || "");
  const commandId = String(frame.commandId || "");
  if (!commandId || (!text && attachments.length === 0)) {
    return { reply: { type: "command.rejected", commandId: commandId || null, code: "COMMAND_INVALID" } };
  }

  const envelope = {
    commandId,
    idempotencyKey: String(frame.idempotencyKey || commandId),
    payloadHash: payloadHashFor(text, attachments),
    lilySessionId: targetSession,
    desktopDeviceId,
    mobileDeviceId: String(frame.mobileDeviceId || ""),
    remoteSessionId: String(frame.remoteSessionId || ""),
    text,
    attachments,
    mode: frame.mode === "steer" ? "steer" : "queue",
    sourceSequence: Number.isFinite(frame.sourceSequence) ? frame.sourceSequence : null,
  };

  let result;
  try {
    result = await admit(envelope);
  } catch (err) {
    return { reply: { type: "command.rejected", commandId, code: "COMMAND_ADMISSION_ERROR", detail: String(err?.message || err) } };
  }
  if (!result?.ok) {
    return { reply: { type: "command.rejected", commandId, code: result?.code || "COMMAND_REJECTED" } };
  }
  // Forward the exact mode fields mobile must render distinctly (contract §3.3).
  return {
    reply: {
      type: "command.admitted",
      commandId: result.commandId,
      state: result.state,
      requestedMode: result.requestedMode,
      effectiveMode: result.effectiveMode,
      downgradeReason: result.downgradeReason ?? null,
    },
  };
}

/**
 * Thin WS-client bridge. Connects to the relay for one grant, admits inbound
 * commands, and can project outbound frames back to mobile. Fail-open: any
 * connection error is logged and retried; it never affects local turns.
 */
function createMobileAgentBridge({
  relayUrl,
  token,
  grantId,
  desktopDeviceId,
  admit,
  interrupt,
  WebSocketCtor = globalThis.WebSocket,
  reconnectDelayMs = 3000,
  log = { info() {}, warn() {} },
} = {}) {
  let ws = null;
  let stopped = false;
  let reconnectTimer = null;

  function url() {
    const q = new URLSearchParams({ role: "desktop", grantId, deviceId: desktopDeviceId, token });
    return `${String(relayUrl).replace(/\/+$/, "")}?${q.toString()}`;
  }

  function connect() {
    if (stopped) return;
    try {
      ws = new WebSocketCtor(url());
    } catch (err) {
      scheduleReconnect(err);
      return;
    }
    ws.onopen = () => log.info("mobile bridge connected: grant=%s", grantId);
    ws.onmessage = async (event) => {
      const { reply } = await handleRelayCommandFrame(event?.data, { admit, interrupt, desktopDeviceId });
      if (reply && ws && ws.readyState === (WebSocketCtor.OPEN ?? 1)) {
        try { ws.send(JSON.stringify(reply)); } catch { /* best effort */ }
      }
    };
    ws.onerror = () => { /* close handler drives reconnect */ };
    ws.onclose = () => { if (!stopped) scheduleReconnect(); };
  }

  function scheduleReconnect(err) {
    if (stopped || reconnectTimer) return;
    if (err) log.warn("mobile bridge error, will reconnect: %s", err?.message || err);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelayMs);
    reconnectTimer.unref?.();
  }

  return {
    start() { stopped = false; connect(); },
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try { ws?.close?.(); } catch { /* noop */ }
      ws = null;
    },
    /** Project a local turn event out to mobile. */
    project(frame) {
      if (ws && ws.readyState === (WebSocketCtor.OPEN ?? 1)) {
        try { ws.send(JSON.stringify(frame)); return true; } catch { return false; }
      }
      return false;
    },
    isConnected() {
      return Boolean(ws && ws.readyState === (WebSocketCtor.OPEN ?? 1));
    },
  };
}

module.exports = {
  MAX_COMMAND_TEXT,
  payloadHashFor,
  handleRelayCommandFrame,
  createMobileAgentBridge,
};
