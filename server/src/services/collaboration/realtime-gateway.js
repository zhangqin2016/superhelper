import crypto from "node:crypto";
import { WebSocketServer } from "ws";

export const COLLABORATION_REALTIME_SCHEMA_VERSION = 1;
const REALTIME_PATH = "/api/collaboration/v1/realtime";
const MAX_TTL_MS = 30_000;

export function parseRealtimeClientFrame(raw) {
  let frame;
  try { frame = JSON.parse(String(raw || "")); } catch { return null; }
  if (!frame || typeof frame !== "object") return null;
  if (frame.type !== "typing" && frame.type !== "presence") return null;
  if (frame.schemaVersion !== COLLABORATION_REALTIME_SCHEMA_VERSION) return null;
  const conversationId = String(frame.conversationId || "").trim();
  if (!conversationId) return null;
  const requestedTtlMs = Number(frame.ttlMs);
  if (!Number.isFinite(requestedTtlMs) || requestedTtlMs < 1000) return null;
  const ttlMs = Math.min(MAX_TTL_MS, requestedTtlMs);
  return { type: frame.type, schemaVersion: COLLABORATION_REALTIME_SCHEMA_VERSION, conversationId, ttlMs };
}

export function createRealtimeConnectionRegistry() {
  const byConnection = new Map();
  const byDevice = new Map();
  return {
    add({ connectionId, userId, deviceId }) {
      const key = `${userId}:${deviceId}`;
      const replacedConnectionId = byDevice.get(key) || null;
      if (replacedConnectionId) byConnection.delete(replacedConnectionId);
      byConnection.set(connectionId, { userId, deviceId });
      byDevice.set(key, connectionId);
      return { replacedConnectionId };
    },
    remove(connectionId) {
      const entry = byConnection.get(connectionId);
      if (!entry) return;
      byConnection.delete(connectionId);
      const key = `${entry.userId}:${entry.deviceId}`;
      if (byDevice.get(key) === connectionId) byDevice.delete(key);
    },
    syncAvailable(userId, cursor) {
      const frame = { type: "sync.available", schemaVersion: COLLABORATION_REALTIME_SCHEMA_VERSION, cursor: Number(cursor) };
      return [...byConnection.entries()].filter(([, entry]) => entry.userId === userId).map(([connectionId]) => ({ connectionId, frame }));
    },
    ephemeralRecipients({ originConnectionId, recipientUserIds }) {
      const recipients = new Set((Array.isArray(recipientUserIds) ? recipientUserIds : []).map(String));
      return [...byConnection.entries()]
        .filter(([connectionId, entry]) => connectionId !== originConnectionId && recipients.has(entry.userId))
        .map(([connectionId]) => ({ connectionId }));
    },
  };
}

export function registerCollaborationRealtimeGateway(app, { ticketService, resolveEphemeralRecipients = async () => [] } = {}) {
  if (!ticketService) throw new TypeError("A collaboration websocket ticket service is required.");
  const registry = createRealtimeConnectionRegistry();
  const sockets = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const send = (connectionId, frame) => {
    const socket = sockets.get(connectionId);
    if (!socket || socket.readyState !== socket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  };
  wss.on("connection", (socket, _request, identity) => {
    const connectionId = `collab_${crypto.randomUUID()}`;
    const { replacedConnectionId } = registry.add({ connectionId, ...identity });
    if (replacedConnectionId) { try { sockets.get(replacedConnectionId)?.close(4000, "REPLACED_BY_RECONNECT"); } catch { /* noop */ } }
    sockets.set(connectionId, socket);
    send(connectionId, { type: "realtime.ready", schemaVersion: COLLABORATION_REALTIME_SCHEMA_VERSION });
    socket.on("message", async (raw) => {
      const frame = parseRealtimeClientFrame(raw);
      if (!frame) { send(connectionId, { type: "realtime.error", schemaVersion: COLLABORATION_REALTIME_SCHEMA_VERSION, code: "REALTIME_FRAME_INVALID" }); return; }
      let recipientUserIds;
      try { recipientUserIds = await resolveEphemeralRecipients({ ...identity, conversationId: frame.conversationId }); } catch { recipientUserIds = []; }
      if (!Array.isArray(recipientUserIds) || !recipientUserIds.includes(identity.userId)) {
        send(connectionId, { type: "realtime.error", schemaVersion: COLLABORATION_REALTIME_SCHEMA_VERSION, code: "REALTIME_NOT_AUTHORIZED" });
        return;
      }
      const outbound = { ...frame, expiresAt: new Date(Date.now() + frame.ttlMs).toISOString() };
      for (const { connectionId: target } of registry.ephemeralRecipients({ originConnectionId: connectionId, recipientUserIds })) send(target, outbound);
    });
    socket.on("close", () => { sockets.delete(connectionId); registry.remove(connectionId); });
  });
  const upgradeHandler = async (request, socket, head) => {
    let url;
    try { url = new URL(request.url, "http://localhost"); } catch { return; }
    if (url.pathname !== REALTIME_PATH) return;
    try {
      // The query carries only the short-lived one-time ticket, never an access token.
      const identity = await ticketService.consume({ ticket: url.searchParams.get("ticket") });
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, identity));
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  };
  app.server.on("upgrade", upgradeHandler);
  app.addHook("onClose", (_instance, done) => { try { wss.close(); } catch { /* noop */ } done(); });
  return { registry, wss, notifySyncAvailable: (userId, cursor) => registry.syncAvailable(userId, cursor).filter(({ connectionId, frame }) => send(connectionId, frame)).length };
}
