// Mobile Command relay routing core.
//
// Pure connection registry + routing decisions for the WebSocket relay — no
// socket, no ws library, no network. The glue (mobile-relay.js) authenticates
// each connection, registers it here, and delivers where this core says.
//
// Three kinds of connection:
//   channel  — a desktop's ONE control connection (protocol 2). It carries every
//              pairing of that desktop; frames to and from it are wrapped as
//              { type: "relay.frame", grantId, frame } so one socket serves many
//              phones, and the server can push pairing events down it.
//   legacy   — a pre-2 desktop: one connection per pairing, raw frames.
//   mobile   — a phone: one connection per pairing, raw frames.
//
// Nothing crosses pairings: a phone reaches only its pairing's desktop, and a
// channel may address only the pairings bound to it (its own device's).

export const RELAY_FRAME = "relay.frame";

export function createRelayRegistry() {
  // grantId -> { desktop: connId | null, mobiles: Set<connId> }
  const grants = new Map();
  // connId -> { kind, deviceId, grantId?, userId?, grantIds?: Set }
  const conns = new Map();
  // desktop deviceId -> channel connId
  const channels = new Map();

  function grantEntry(grantId) {
    let entry = grants.get(grantId);
    if (!entry) {
      entry = { desktop: null, mobiles: new Set() };
      grants.set(grantId, entry);
    }
    return entry;
  }

  function dropIfEmpty(grantId) {
    const entry = grants.get(grantId);
    if (entry && !entry.desktop && entry.mobiles.size === 0) grants.delete(grantId);
  }

  // Put `connId` in front of a pairing; the displaced desktop (if any) loses it.
  function attachDesktop(grantId, connId) {
    const entry = grantEntry(grantId);
    const previous = entry.desktop && entry.desktop !== connId ? entry.desktop : null;
    entry.desktop = connId;
    if (previous) {
      const prevMeta = conns.get(previous);
      if (prevMeta?.kind === "legacy") conns.delete(previous);
      else prevMeta?.grantIds?.delete(grantId);
    }
    return previous;
  }

  function detachDesktop(grantId, connId) {
    const entry = grants.get(grantId);
    if (entry?.desktop === connId) entry.desktop = null;
    dropIfEmpty(grantId);
  }

  return {
    /**
     * A desktop's control channel. Replaces an earlier channel of the same
     * device, and any legacy connection of the pairings it carries.
     * @returns {{ok:boolean, code?:string, replaced:string[]}} connections to close
     */
    addChannel({ connId, deviceId, userId, grantIds = [] }) {
      if (!connId || !deviceId || !userId) return { ok: false, code: "RELAY_CONN_INVALID", replaced: [] };
      if (conns.has(connId)) return { ok: false, code: "RELAY_CONN_DUPLICATE", replaced: [] };
      const replaced = [];
      const previousChannel = channels.get(deviceId);
      if (previousChannel) {
        replaced.push(previousChannel);
        this.remove(previousChannel);
      }
      conns.set(connId, { kind: "channel", deviceId, userId, grantIds: new Set() });
      channels.set(deviceId, connId);
      for (const grantId of grantIds) {
        const previous = this.bindGrant(connId, grantId);
        if (previous) replaced.push(previous);
      }
      return { ok: true, replaced };
    },

    /** A pre-2 desktop joining one pairing. */
    addLegacyDesktop({ connId, grantId, deviceId }) {
      if (!connId || !grantId || !deviceId) return { ok: false, code: "RELAY_CONN_INVALID", replaced: [] };
      if (conns.has(connId)) return { ok: false, code: "RELAY_CONN_DUPLICATE", replaced: [] };
      conns.set(connId, { kind: "legacy", deviceId, grantId });
      const previous = attachDesktop(grantId, connId);
      return { ok: true, replaced: previous ? [previous] : [] };
    },

    addMobile({ connId, grantId, deviceId }) {
      if (!connId || !grantId || !deviceId) return { ok: false, code: "RELAY_CONN_INVALID" };
      if (conns.has(connId)) return { ok: false, code: "RELAY_CONN_DUPLICATE" };
      conns.set(connId, { kind: "mobile", deviceId, grantId });
      grantEntry(grantId).mobiles.add(connId);
      return { ok: true };
    },

    /**
     * Put a pairing on a channel (at connect, or when it becomes active).
     * @returns {string|null} a desktop connection it displaced
     */
    bindGrant(channelConnId, grantId) {
      const meta = conns.get(channelConnId);
      if (meta?.kind !== "channel" || !grantId) return null;
      meta.grantIds.add(grantId);
      return attachDesktop(grantId, channelConnId);
    },

    /**
     * A pairing ended. Returns its connections — phones and a legacy desktop
     * to close, the channel to notify — and forgets the pairing.
     */
    endGrant(grantId) {
      const entry = grants.get(grantId);
      if (!entry) return { mobiles: [], legacyDesktop: null, channel: null };
      const desktopMeta = entry.desktop ? conns.get(entry.desktop) : null;
      const result = {
        mobiles: [...entry.mobiles],
        legacyDesktop: desktopMeta?.kind === "legacy" ? entry.desktop : null,
        channel: desktopMeta?.kind === "channel" ? entry.desktop : null,
      };
      for (const connId of result.mobiles) conns.delete(connId);
      if (result.legacyDesktop) conns.delete(result.legacyDesktop);
      if (result.channel) desktopMeta.grantIds.delete(grantId);
      grants.delete(grantId);
      return result;
    },

    /** Forget a connection. Returns the pairings whose presence changed. */
    remove(connId) {
      const meta = conns.get(connId);
      if (!meta) return { ok: false, grantIds: [] };
      conns.delete(connId);
      if (meta.kind === "mobile") {
        grants.get(meta.grantId)?.mobiles.delete(connId);
        dropIfEmpty(meta.grantId);
        return { ok: true, grantIds: [meta.grantId] };
      }
      if (meta.kind === "legacy") {
        detachDesktop(meta.grantId, connId);
        return { ok: true, grantIds: [meta.grantId] };
      }
      if (channels.get(meta.deviceId) === connId) channels.delete(meta.deviceId);
      const grantIds = [...meta.grantIds];
      for (const grantId of grantIds) detachDesktop(grantId, connId);
      return { ok: true, grantIds };
    },

    /**
     * Where a frame from `connId` goes. `frame` is the parsed JSON.
     * @returns {{ok:boolean, code?:string, frame?:object,
     *            deliveries:{connId:string, grantId?:string, wrap:boolean}[]}}
     *   `wrap` = deliver inside a relay.frame envelope (to a channel); `frame`
     *   is what to deliver (the inner frame when a channel sent an envelope).
     */
    route(connId, frame) {
      const meta = conns.get(connId);
      if (!meta) return { ok: false, code: "RELAY_CONN_UNKNOWN", deliveries: [] };
      if (meta.kind === "mobile") {
        const desktop = grants.get(meta.grantId)?.desktop || null;
        if (!desktop) return { ok: true, deliveries: [], frame };
        const wrap = conns.get(desktop)?.kind === "channel";
        return { ok: true, deliveries: [{ connId: desktop, grantId: meta.grantId, wrap }], frame };
      }
      if (meta.kind === "legacy") {
        const mobiles = [...(grants.get(meta.grantId)?.mobiles || [])];
        return { ok: true, deliveries: mobiles.map((id) => ({ connId: id, wrap: false })), frame };
      }
      // A channel may only address a pairing it carries, through an envelope.
      if (frame?.type !== RELAY_FRAME || !frame.grantId || !frame.frame || typeof frame.frame !== "object") {
        return { ok: false, code: "RELAY_FRAME_INVALID", deliveries: [] };
      }
      if (!meta.grantIds.has(frame.grantId)) return { ok: false, code: "RELAY_GRANT_NOT_BOUND", deliveries: [] };
      const mobiles = [...(grants.get(frame.grantId)?.mobiles || [])];
      return { ok: true, deliveries: mobiles.map((id) => ({ connId: id, wrap: false })), frame: frame.frame };
    },

    /** Who is on the line for a pairing. */
    presence(grantId) {
      const entry = grants.get(grantId);
      return { desktop: Boolean(entry?.desktop), mobiles: entry ? entry.mobiles.size : 0 };
    },

    /** A pairing's desktop connection (and its kind) and its phones. */
    connsForGrant(grantId) {
      const entry = grants.get(grantId);
      if (!entry) return { desktop: null, desktopKind: null, mobiles: [] };
      return {
        desktop: entry.desktop,
        desktopKind: entry.desktop ? conns.get(entry.desktop)?.kind || null : null,
        mobiles: [...entry.mobiles],
      };
    },

    channelFor(deviceId) {
      return channels.get(deviceId) || null;
    },

    connInfo(connId) {
      const meta = conns.get(connId);
      if (!meta) return null;
      return meta.kind === "channel" ? { ...meta, grantIds: [...meta.grantIds] } : { ...meta };
    },

    stats() {
      return { grants: grants.size, connections: conns.size, channels: channels.size };
    },
  };
}
