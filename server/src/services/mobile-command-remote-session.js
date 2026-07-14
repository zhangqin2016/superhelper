import { randomUUID } from "node:crypto";

const REMOTE_SESSION_TTL_MS = 30 * 60 * 1000;
const SUPPORTED_PROTOCOL_VERSION = 1;

function publicId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function shapeSession(row) {
  return {
    remoteSessionId: row.remoteSessionId,
    grantId: row.grantId,
    mobileDeviceId: row.mobileDeviceId,
    lilySessionId: row.lilySessionId,
    status: row.status,
    permissionLevel: row.permissionLevel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

function createMobileRemoteSessionService({ nowMs = () => Date.now(), ttlMs = REMOTE_SESSION_TTL_MS } = {}) {
  const sessions = new Map();

  function createSession(input = {}) {
    const grantId = String(input.grantId || "");
    const mobileDeviceId = String(input.deviceId || input.mobileDeviceId || "");
    const lilySessionId = String(input.lilySessionId || "");
    const protocol = Number(input.clientProtocolVersion || SUPPORTED_PROTOCOL_VERSION);
    if (protocol !== SUPPORTED_PROTOCOL_VERSION) return { ok: false, code: "MC-ERR-PROTOCOL-CLIENT-UPGRADE-REQUIRED" };
    if (!grantId || !mobileDeviceId) return { ok: false, code: "MC-ERR-PROTOCOL-INVALID" };
    const now = nowMs();
    const row = {
      remoteSessionId: publicId("mrs"),
      grantId,
      mobileDeviceId,
      lilySessionId,
      status: "active",
      permissionLevel: "chat",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMs,
    };
    sessions.set(row.remoteSessionId, row);
    return { ok: true, remoteSession: shapeSession(row) };
  }

  function getSession(remoteSessionId) {
    const row = sessions.get(String(remoteSessionId || ""));
    if (!row) return { ok: false, code: "MC-ERR-SESSION-NOT-FOUND" };
    return { ok: true, remoteSession: shapeSession(row) };
  }

  function refreshSession(input = {}) {
    const row = sessions.get(String(input.remoteSessionId || ""));
    if (!row) return { ok: false, code: "MC-ERR-SESSION-NOT-FOUND" };
    const deviceId = String(input.deviceId || input.mobileDeviceId || "");
    if (deviceId && deviceId !== row.mobileDeviceId) return { ok: false, code: "MC-ERR-PERMISSION-DENIED" };
    if (row.status !== "active") return { ok: false, code: "MC-ERR-SESSION-ENDED" };
    const now = nowMs();
    row.updatedAt = now;
    row.expiresAt = now + ttlMs;
    return { ok: true, remoteSession: shapeSession(row) };
  }

  function endSession(input = {}) {
    const row = sessions.get(String(input.remoteSessionId || ""));
    if (!row) return { ok: false, code: "MC-ERR-SESSION-NOT-FOUND" };
    const deviceId = String(input.deviceId || input.mobileDeviceId || "");
    if (deviceId && deviceId !== row.mobileDeviceId) return { ok: false, code: "MC-ERR-PERMISSION-DENIED" };
    row.status = "ended";
    row.updatedAt = nowMs();
    return { ok: true, remoteSession: shapeSession(row) };
  }

  return { createSession, getSession, refreshSession, endSession };
}

export {
  REMOTE_SESSION_TTL_MS,
  SUPPORTED_PROTOCOL_VERSION,
  createMobileRemoteSessionService,
};
