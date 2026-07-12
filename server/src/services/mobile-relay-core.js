// Mobile Command relay routing core (Phase 1 text channel).
//
// Pure connection registry + routing decisions for the WebSocket relay: it
// knows which desktop and which mobile devices belong to a pairing grant and
// where a message should go, WITHOUT any socket, ws library, or network. The
// ws-server glue (mobile-relay.js) authenticates each connection, then feeds
// opaque connection handles here and sends where this core says.
//
// Routing rule (Phase 1): a grant binds exactly one desktop to one mobile.
// A mobile's command envelope routes to that grant's desktop; a desktop's
// projection routes to that grant's mobile connections. Nothing crosses grants.

export function createRelayRegistry() {
  // grantId -> { desktop: {connId, deviceId} | null, mobiles: Map<connId,{deviceId}> }
  const grants = new Map();
  // connId -> { grantId, role, deviceId }
  const conns = new Map();

  function grantEntry(grantId) {
    let entry = grants.get(grantId);
    if (!entry) {
      entry = { desktop: null, mobiles: new Map() };
      grants.set(grantId, entry);
    }
    return entry;
  }

  return {
    /**
     * Register an authenticated connection.
     * @param {{connId:string, role:"desktop"|"mobile", grantId:string, deviceId:string}} conn
     * @returns {{ok:boolean, code?:string, replaced?:string|null}}
     */
    add({ connId, role, grantId, deviceId }) {
      if (!connId || !grantId || !deviceId) return { ok: false, code: "RELAY_CONN_INVALID" };
      if (role !== "desktop" && role !== "mobile") return { ok: false, code: "RELAY_ROLE_INVALID" };
      if (conns.has(connId)) return { ok: false, code: "RELAY_CONN_DUPLICATE" };
      const entry = grantEntry(grantId);
      let replaced = null;
      if (role === "desktop") {
        // One desktop per grant: a reconnecting desktop replaces the stale one.
        replaced = entry.desktop?.connId || null;
        if (replaced) conns.delete(replaced);
        entry.desktop = { connId, deviceId };
      } else {
        entry.mobiles.set(connId, { deviceId });
      }
      conns.set(connId, { grantId, role, deviceId });
      return { ok: true, replaced };
    },

    remove(connId) {
      const meta = conns.get(connId);
      if (!meta) return { ok: false };
      conns.delete(connId);
      const entry = grants.get(meta.grantId);
      if (entry) {
        if (meta.role === "desktop" && entry.desktop?.connId === connId) entry.desktop = null;
        else entry.mobiles.delete(connId);
        if (!entry.desktop && entry.mobiles.size === 0) grants.delete(meta.grantId);
      }
      return { ok: true, meta };
    },

    /**
     * Given the sender connection, return the connIds a message should be
     * delivered to. A mobile→desktop command targets the one desktop; a
     * desktop→mobile projection targets every mobile of the grant. Returns []
     * when the peer is absent (offline), which the caller reports upstream.
     */
    targetsFor(connId) {
      const meta = conns.get(connId);
      if (!meta) return { ok: false, code: "RELAY_CONN_UNKNOWN", targets: [] };
      const entry = grants.get(meta.grantId);
      if (!entry) return { ok: true, targets: [] };
      if (meta.role === "mobile") {
        return { ok: true, targets: entry.desktop ? [entry.desktop.connId] : [] };
      }
      return { ok: true, targets: [...entry.mobiles.keys()] };
    },

    connInfo(connId) {
      return conns.get(connId) || null;
    },

    stats() {
      return { grants: grants.size, connections: conns.size };
    },
  };
}
