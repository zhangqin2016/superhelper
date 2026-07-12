"use strict";

/**
 * Desktop pairing manager for Mobile Command (Phase 1).
 *
 * Orchestrates the desktop side of pairing on top of the signed service client:
 *   createChallenge → (render QR) → pollPending → approve/deny → start bridge.
 * All I/O is injected (serviceFetch, account token, bridge factory, clock) so
 * the flow is unit-tested without Electron, network, or a live server. The IPC
 * layer wires the real serviceFetch / accountManager / agent bridge onto this.
 */

const RELAY_PATH = "/api/mobile/relay";

function buildQrPayload({ serverBaseUrl, token, desktopDeviceId }) {
  // The mobile scans this: enough to reach the server and claim the challenge.
  // The raw token appears ONLY here (and in the desktop's memory) — never
  // persisted server-side (only its hash is).
  return { v: 1, url: String(serverBaseUrl || "").replace(/\/+$/, ""), token, desktopDeviceId };
}

function createMobilePairingManager({
  serviceFetch,
  getAccountToken,
  getDesktopDeviceId,
  getServerBaseUrl,
  getRelayUrl,
  startBridge, // ({ relayUrl, token, grantId, desktopDeviceId }) -> bridge
  now = () => new Date(),
  log = { info() {}, warn() {} },
} = {}) {
  let activeBridge = null;
  let activeGrantId = null;

  async function authedPost(pathname, body) {
    const tokenResult = await getAccountToken();
    if (!tokenResult?.ok || !tokenResult.accessToken) {
      return { ok: false, code: "ACCOUNT_LOGIN_REQUIRED" };
    }
    const desktopDeviceId = getDesktopDeviceId();
    const payload = { deviceId: desktopDeviceId, ...body };
    const res = await serviceFetch(pathname, {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { Authorization: `Bearer ${tokenResult.accessToken}` },
    });
    return res;
  }

  return {
    /** Create a challenge and return the QR payload for the mobile to scan. */
    async createChallenge() {
      const res = await authedPost("/api/mobile/pairing/challenge", {});
      if (!res?.ok || !res.json?.ok) {
        return { ok: false, code: res?.json?.code || res?.code || res?.error || "PAIRING_CHALLENGE_FAILED" };
      }
      return {
        ok: true,
        challengeId: res.json.challengeId,
        expiresAt: res.json.expiresAt,
        qr: buildQrPayload({
          serverBaseUrl: getServerBaseUrl(),
          token: res.json.token,
          desktopDeviceId: getDesktopDeviceId(),
        }),
      };
    },

    /** Poll for mobiles that consumed a challenge and await approval. */
    async pollPending() {
      const res = await authedPost("/api/mobile/pairing/pending", {});
      if (!res?.ok || !res.json?.ok) {
        return { ok: false, code: res?.json?.code || res?.code || res?.error || "PAIRING_PENDING_FAILED" };
      }
      return { ok: true, grants: Array.isArray(res.json.grants) ? res.json.grants : [] };
    },

    /** Approve a pending grant, then bring the relay bridge online for it. */
    async approve(grantId) {
      if (!grantId) return { ok: false, code: "PAIRING_APPROVE_INVALID" };
      const res = await authedPost("/api/mobile/pairing/approve", { grantId });
      if (!res?.ok || !res.json?.ok) {
        return { ok: false, code: res?.json?.code || res?.code || res?.error || "PAIRING_APPROVE_FAILED" };
      }
      await this._connectBridge(grantId);
      return { ok: true, grantId, status: "active", bridged: Boolean(activeBridge) };
    },

    async deny(grantId) {
      if (!grantId) return { ok: false, code: "PAIRING_DENY_INVALID" };
      const res = await authedPost("/api/mobile/pairing/deny", { grantId });
      if (!res?.ok || !res.json?.ok) return { ok: false, code: res?.json?.code || res?.code || res?.error || "PAIRING_DENY_FAILED" };
      return { ok: true, grantId, status: "denied" };
    },

    async revoke(grantId, reason) {
      if (!grantId) return { ok: false, code: "PAIRING_REVOKE_INVALID" };
      const res = await authedPost("/api/mobile/pairing/revoke", { grantId, reason });
      if (grantId === activeGrantId) this.stopBridge();
      if (!res?.ok || !res.json?.ok) return { ok: false, code: res?.json?.code || res?.code || res?.error || "PAIRING_REVOKE_FAILED" };
      return { ok: true, grantId, status: "revoked" };
    },

    async _connectBridge(grantId) {
      const relayUrl = getRelayUrl();
      const tokenResult = await getAccountToken();
      if (!relayUrl || !tokenResult?.ok || typeof startBridge !== "function") {
        log.warn("pairing approved but relay bridge not started (relayUrl/token/factory missing)");
        return;
      }
      this.stopBridge();
      activeBridge = startBridge({
        relayUrl: relayUrl.endsWith(RELAY_PATH) ? relayUrl : `${relayUrl.replace(/\/+$/, "")}${RELAY_PATH}`,
        token: tokenResult.accessToken,
        grantId,
        desktopDeviceId: getDesktopDeviceId(),
      });
      activeGrantId = grantId;
      activeBridge?.start?.();
    },

    stopBridge() {
      try { activeBridge?.stop?.(); } catch { /* best effort */ }
      activeBridge = null;
      activeGrantId = null;
    },

    isBridged() {
      return Boolean(activeBridge?.isConnected?.());
    },
  };
}

module.exports = { buildQrPayload, createMobilePairingManager, RELAY_PATH };
