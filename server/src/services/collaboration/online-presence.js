export const ONLINE_TTL_MS = 75_000;
export function createOnlinePresence({ now = () => Date.now() } = {}) {
  const connections = new Map();
  return {
    connect(id, identity) { connections.set(id, { ...identity, expiresAt: now() + ONLINE_TTL_MS }); },
    touch(id) { const entry = connections.get(id); if (entry) entry.expiresAt = now() + ONLINE_TTL_MS; },
    disconnect(id) { connections.delete(id); },
    expiresAt(userId, activeDevices) {
      let expiry = 0;
      for (const entry of connections.values()) if (entry.userId === userId && entry.expiresAt > now() && activeDevices.has(entry.deviceId)) expiry = Math.max(expiry, entry.expiresAt);
      return expiry ? new Date(expiry).toISOString() : null;
    },
    expiredIds() { return [...connections].filter(([, entry]) => entry.expiresAt <= now()).map(([id]) => id); },
    clear() { connections.clear(); },
  };
}
