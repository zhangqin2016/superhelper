import { createOnlinePresence } from "./online-presence.js";
import { createPresenceHintCoalescer } from "./presence-redis.js";
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

export function registerCollaborationRealtimeGateway(app, { ticketService, presence = createOnlinePresence(), resolveEphemeralRecipients = async () => [] } = {}) {
  if (!ticketService) throw new TypeError("A collaboration websocket ticket service is required.");
  const registry = createRealtimeConnectionRegistry();
  app.collaborationPresence = presence;
  const sockets = new Map();
  let closing = false;
  const updatePresence = (method, ...args) => { try { Promise.resolve(presence[method](...args)).catch(() => {}); } catch { /* optional presence cannot interrupt transport */ } };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const send = (connectionId, frame) => {
    const socket = sockets.get(connectionId);
    if (!socket || socket.readyState !== socket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  };
  // Both local mutations and cross-instance subscription callbacks use this
  // receiving boundary, so the number of publishers cannot multiply socket fanout.
  const presenceHints = createPresenceHintCoalescer({ emit: () => {
    if (!closing) for (const id of sockets.keys()) send(id, { type: "presence.changed", schemaVersion: 1 });
  } });
  wss.on("connection", (socket, _request, identity) => {
    const connectionId = `collab_${crypto.randomUUID()}`;
    const { replacedConnectionId } = registry.add({ connectionId, ...identity });
    if (replacedConnectionId) { try { sockets.get(replacedConnectionId)?.close(4000, "REPLACED_BY_RECONNECT"); } catch { /* noop */ } }
    if (replacedConnectionId) updatePresence("disconnect", replacedConnectionId);
    updatePresence("connect", connectionId, identity);
    sockets.set(connectionId, socket);
    send(connectionId, { type: "realtime.ready", schemaVersion: COLLABORATION_REALTIME_SCHEMA_VERSION });
    socket.on("message", async (raw) => {
      let heartbeat;
      try { heartbeat = JSON.parse(String(raw)); } catch { /* invalid frame below */ }
      if (heartbeat?.type === "realtime.heartbeat" && heartbeat.schemaVersion === 1) {
        if (sockets.get(connectionId) !== socket || closing) return;
        updatePresence("touch", connectionId);
        send(connectionId, { type: "realtime.heartbeat-ack", schemaVersion: 1 });
        return;
      }
      const frame = parseRealtimeClientFrame(raw);
      if (!frame) { send(connectionId, { type: "realtime.error", schemaVersion: COLLABORATION_REALTIME_SCHEMA_VERSION, code: "REALTIME_FRAME_INVALID" }); return; }
      let recipientUserIds;
      try { recipientUserIds = await resolveEphemeralRecipients({ ...identity, conversationId: frame.conversationId }); } catch { recipientUserIds = []; }
      if (!Array.isArray(recipientUserIds) || !recipientUserIds.includes(identity.userId)) {
        send(connectionId, { type: "realtime.error", schemaVersion: COLLABORATION_REALTIME_SCHEMA_VERSION, code: "REALTIME_NOT_AUTHORIZED" });
        return;
      }
      // Name the origin. Without it a recipient only learns that SOMEONE in the
      // conversation is typing, which is enough for a 1:1 but not for a group
      // where the UI has to say who. The id is the authenticated identity, never
      // anything the client put in the frame.
      const outbound = { ...frame, userId: identity.userId, expiresAt: new Date(Date.now() + frame.ttlMs).toISOString() };
      for (const { connectionId: target } of registry.ephemeralRecipients({ originConnectionId: connectionId, recipientUserIds })) send(target, outbound);
    });
    socket.on("close", () => { sockets.delete(connectionId); registry.remove(connectionId); updatePresence("disconnect", connectionId); });
  });
  const expiryTimer = setInterval(() => { for (const id of presence.expiredIds()) { updatePresence("disconnect", id); sockets.get(id)?.terminate(); } }, 30000);
  expiryTimer.unref?.();
  const upgradeHandler = async (request, socket, head) => {
    let url;
    try { url = new URL(request.url, "http://localhost"); } catch { return; }
    if (url.pathname !== REALTIME_PATH) return;
    try {
      // The query carries only the short-lived one-time ticket, never an access token.
      const identity = await ticketService.consume({ ticket: url.searchParams.get("ticket") });
      if (closing || socket.destroyed) { socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, identity));
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  };
  app.server.on("upgrade", upgradeHandler);
  app.addHook("preClose", async () => { closing = true; presenceHints.stop(); clearInterval(expiryTimer); app.server.removeListener("upgrade", upgradeHandler); for (const socket of sockets.values()) socket.terminate(); });
  app.addHook("onClose", async () => { closing = true; clearInterval(expiryTimer); app.server.removeListener("upgrade", upgradeHandler); for (const socket of sockets.values()) socket.terminate(); try { await presence.clear(); } catch { /* leases expire */ } try { wss.close(); } catch { /* noop */ } });
  return { registry, wss, notifyPresenceChanged: () => presenceHints.notify(), notifySyncAvailable: (userId, cursor) => registry.syncAvailable(userId, cursor).filter(({ connectionId, frame }) => send(connectionId, frame)).length };
}
