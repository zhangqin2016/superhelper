"use strict";

/**
 * Which phones this desktop is paired with, which are asking to pair, and
 * which are on the line — as the relay last told us. Pure state: control
 * channel events go in, a snapshot comes out, listeners hear every change.
 *
 * `hello` REPLACES the state (it is the server's full truth on every connect);
 * the incremental events keep it current between connects. Nothing here
 * polls: the settings page renders this snapshot and is pushed each change.
 */

function createPhoneDirectory({ now = () => Date.now() } = {}) {
  let phones = new Map(); // grantId -> { grant, mobilesOnline }
  let pending = new Map(); // grantId -> grant
  let channelStatus = "idle";
  const listeners = new Set();

  function changed() {
    for (const listener of listeners) {
      try { listener(); } catch { /* a listener never breaks the directory */ }
    }
  }

  function livePending() {
    const t = now();
    return [...pending.values()].filter((grant) => {
      const expires = Date.parse(String(grant.approvalExpiresAt || ""));
      return !Number.isFinite(expires) || expires > t;
    });
  }

  return {
    /** Apply a control-channel event. Returns true when the state changed. */
    apply(event) {
      switch (event?.type) {
        case "status":
          if (channelStatus === event.status) return false;
          channelStatus = event.status;
          // Offline: we no longer know who is on the line.
          if (event.status !== "online") for (const entry of phones.values()) entry.mobilesOnline = 0;
          break;
        case "hello":
          phones = new Map((event.grants || []).map((grant) => [grant.grantId, { grant, mobilesOnline: phones.get(grant.grantId)?.mobilesOnline || 0 }]));
          pending = new Map((event.pending || []).map((grant) => [grant.grantId, grant]));
          break;
        case "pending":
          pending.set(event.grant.grantId, event.grant);
          break;
        case "active":
          pending.delete(event.grant.grantId);
          phones.set(event.grant.grantId, { grant: event.grant, mobilesOnline: phones.get(event.grant.grantId)?.mobilesOnline || 0 });
          break;
        case "ended":
          if (!phones.delete(event.grantId) && !pending.delete(event.grantId)) return false;
          pending.delete(event.grantId);
          break;
        case "presence": {
          const entry = phones.get(event.grantId);
          if (!entry || entry.mobilesOnline === event.mobilesOnline) return false;
          entry.mobilesOnline = event.mobilesOnline;
          break;
        }
        default:
          return false;
      }
      changed();
      return true;
    },

    has(grantId) {
      return phones.has(grantId);
    },

    grantIds() {
      return [...phones.keys()];
    },

    snapshot() {
      return {
        channel: channelStatus,
        phones: [...phones.values()].map(({ grant, mobilesOnline }) => ({ ...grant, online: mobilesOnline > 0 })),
        pending: livePending(),
      };
    },

    /** When the soonest pending request lapses (ms epoch), for a re-render. */
    nextExpiry() {
      const times = livePending().map((g) => Date.parse(String(g.approvalExpiresAt || ""))).filter(Number.isFinite);
      return times.length ? Math.min(...times) : null;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = { createPhoneDirectory };
