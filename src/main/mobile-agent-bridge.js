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
const MAX_ATTACHMENTS = 6;
const SUPPORTED_PROTOCOL_VERSION = 1;

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
async function handleRelayCommandFrame(rawFrame, {
  admit,
  interrupt,
  getSessionContext,
  getSessionList,
  selectSession,
  getProjectList,
  selectProject,
  materializeAttachments,
  desktopDeviceId = "",
  lilySessionId = "",
} = {}) {
  let frame;
  try {
    frame = typeof rawFrame === "string" ? JSON.parse(rawFrame) : rawFrame;
  } catch {
    return { reply: { type: "relay.error", code: "COMMAND_FRAME_MALFORMED" } };
  }
  if (!frame) return { reply: null };

  // Phone asks which session it controls + recent history.
  if (frame.type === "session.request") {
    if (typeof getSessionContext !== "function") return { reply: null };
    try {
      const ctx = await getSessionContext();
      return { reply: ctx || null };
    } catch {
      return { reply: null };
    }
  }

  if (frame.type === "sessions.request") {
    if (typeof getSessionList !== "function") return { reply: null };
    try {
      const list = await getSessionList();
      return { reply: list || null };
    } catch {
      return { reply: null };
    }
  }

  if (frame.type === "session.select") {
    const sessionId = String(frame.sessionId || "");
    if (!sessionId) return { reply: { type: "session.select.ack", ok: false, sessionId: "", code: "SESSION_INVALID" } };
    if (typeof selectSession !== "function") {
      return { reply: { type: "session.select.ack", ok: false, sessionId, code: "SESSION_SELECT_UNAVAILABLE" } };
    }
    try {
      const ctx = await selectSession(sessionId);
      return { reply: ctx || { type: "session.select.ack", ok: false, sessionId, code: "SESSION_NOT_FOUND" } };
    } catch {
      return { reply: { type: "session.select.ack", ok: false, sessionId, code: "SESSION_SELECT_ERROR" } };
    }
  }

  // Phone asks for the workspace (project) list, or selects one.
  if (frame.type === "projects.request") {
    if (typeof getProjectList !== "function") return { reply: null };
    try { return { reply: (await getProjectList()) || null }; } catch { return { reply: null }; }
  }
  if (frame.type === "project.select") {
    const projectId = String(frame.projectId || "");
    if (!projectId) return { reply: { type: "project.select.ack", ok: false, projectId: "", code: "PROJECT_INVALID" } };
    if (typeof selectProject !== "function") return { reply: { type: "project.select.ack", ok: false, projectId, code: "PROJECT_SELECT_UNAVAILABLE" } };
    try {
      const list = await selectProject(projectId);
      return { reply: list || { type: "project.select.ack", ok: false, projectId, code: "PROJECT_NOT_FOUND" } };
    } catch {
      return { reply: { type: "project.select.ack", ok: false, projectId, code: "PROJECT_SELECT_ERROR" } };
    }
  }

  // Mobile "stop": interrupt the running turn through the controlled seam
  // (never the runner directly). Fail-open — a failed interrupt just acks false.
  if (frame.type === "interrupt") {
    const correlationId = String(frame.correlationId || "");
    if (typeof interrupt !== "function") return { reply: { type: "interrupt.ack", ok: false, correlationId: correlationId || null, code: "INTERRUPT_UNAVAILABLE" } };
    try {
      const r = await interrupt({ turnId: String(frame.turnId || ""), correlationId });
      return { reply: { type: "interrupt.ack", ok: Boolean(r?.ok ?? true), turnId: frame.turnId || null, correlationId: correlationId || null } };
    } catch (err) {
      return { reply: { type: "interrupt.ack", ok: false, correlationId: correlationId || null, code: "INTERRUPT_ERROR", detail: String(err?.message || err) } };
    }
  }

  if (frame.type !== "command") return { reply: null };

  const protocolVersion = Number(frame.protocolVersion || SUPPORTED_PROTOCOL_VERSION);
  const commandId = String(frame.commandId || "");
  const correlationId = String(frame.correlationId || commandId || "");
  if (protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
    return { reply: { type: "command.rejected", commandId: commandId || null, correlationId: correlationId || null, code: "CLIENT_UPGRADE_REQUIRED" } };
  }

  const rawText = String(frame.text || "");
  if (rawText.length > MAX_COMMAND_TEXT) {
    return { reply: { type: "command.rejected", commandId: commandId || null, correlationId: correlationId || null, code: "COMMAND_TEXT_TOO_LARGE" } };
  }
  const text = rawText;
  const attachments = Array.isArray(frame.attachments) ? frame.attachments : [];
  if (attachments.length > MAX_ATTACHMENTS) {
    return { reply: { type: "command.rejected", commandId: commandId || null, correlationId: correlationId || null, code: "ATTACHMENT_COUNT_EXCEEDED" } };
  }
  const targetSession = String(frame.lilySessionId || lilySessionId || "");
  if (!commandId || (!text && attachments.length === 0)) {
    return { reply: { type: "command.rejected", commandId: commandId || null, correlationId: correlationId || null, code: "COMMAND_INVALID" } };
  }

  // Materialize any phone-sent attachments (base64) to local temp files so the
  // turn gets real paths (the agent reads files from disk). Fail-open: if
  // materialization is unavailable or throws, the command still runs as
  // text-only (never worse than baseline); the agent also has its own
  // unreadable-file fallback manifest.
  let files = [];
  let attachmentStatus = attachments.length ? "dropped" : "none";
  if (attachments.length && typeof materializeAttachments === "function") {
    try { files = (await materializeAttachments(attachments)) || []; }
    catch { files = []; }
  }
  if (attachments.length && files.length > 0) {
    attachmentStatus = files.length >= attachments.length ? "attached" : "partial";
  }

  const envelope = {
    commandId,
    idempotencyKey: String(frame.idempotencyKey || commandId),
    correlationId,
    payloadHash: payloadHashFor(text, attachments),
    lilySessionId: targetSession,
    desktopDeviceId,
    mobileDeviceId: String(frame.mobileDeviceId || ""),
    remoteSessionId: String(frame.remoteSessionId || ""),
    text,
    attachments,
    files,
    attachmentStatus,
    attachmentCount: attachments.length,
    materializedFileCount: files.length,
    mode: frame.mode === "steer" ? "steer" : "queue",
    sourceSequence: Number.isFinite(frame.sourceSequence) ? frame.sourceSequence : null,
  };

  let result;
  try {
    result = await admit(envelope);
  } catch (err) {
    return { reply: { type: "command.rejected", commandId, correlationId, code: "COMMAND_ADMISSION_ERROR", detail: String(err?.message || err) } };
  }
  if (!result?.ok) {
    return { reply: { type: "command.rejected", commandId, correlationId, code: result?.code || "COMMAND_REJECTED" } };
  }
  // Forward the exact mode fields mobile must render distinctly (contract §3.3).
  return {
    reply: {
      type: "command.admitted",
      commandId: result.commandId,
      correlationId: result.correlationId || correlationId,
      attachmentStatus,
      attachmentCount: attachments.length,
      materializedFileCount: files.length,
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
  getSessionContext,
  getSessionList,
  selectSession,
  getProjectList,
  selectProject,
  materializeAttachments,
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
      const { reply } = await handleRelayCommandFrame(event?.data, {
        admit,
        interrupt,
        getSessionContext,
        getSessionList,
        selectSession,
        getProjectList,
        selectProject,
        materializeAttachments,
        desktopDeviceId,
      });
      if (reply?.type === "command.admitted") log.info("mobile command admitted: correlation=%s command=%s mode=%s", reply.correlationId || "", reply.commandId || "", reply.effectiveMode || "");
      if (reply?.type === "command.rejected") log.warn("mobile command rejected: correlation=%s command=%s code=%s", reply.correlationId || "", reply.commandId || "", reply.code || "");
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
  MAX_ATTACHMENTS,
  MAX_COMMAND_TEXT,
  SUPPORTED_PROTOCOL_VERSION,
  payloadHashFor,
  handleRelayCommandFrame,
  createMobileAgentBridge,
};
