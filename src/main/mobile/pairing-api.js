"use strict";

/**
 * The pairing operations the desktop USER performs, over the signed service
 * client: show a QR, show a direct code, approve, deny, unpair. Request/response
 * only — what happens next (a pairing becoming live, ending) arrives as a pushed
 * event on the control channel, not as something to poll for here.
 */

function buildQrPayload({ serverBaseUrl, token, desktopDeviceId }) {
  // The raw token appears ONLY here (and in the desktop's memory) — the server
  // keeps its hash. The scan link lands the phone camera on /m/pair with the API
  // base (u) and the one-time token (t); `${url}#${token}` is the paste form.
  const url = String(serverBaseUrl || "").replace(/\/+$/, "");
  const scanUrl = url ? `${url}/m/pair#u=${encodeURIComponent(url)}&t=${encodeURIComponent(token)}` : "";
  return { v: 1, url, token, desktopDeviceId, scanUrl };
}

function failure(res, fallback) {
  return { ok: false, code: res?.json?.code || res?.code || res?.error || fallback };
}

function createPairingApi({
  serviceFetch,
  getAccountToken,
  getDesktopDeviceId,
  getServerBaseUrl,
  makeQrImage = async () => "",
  log = { warn() {} },
}) {
  async function authedPost(pathname, body = {}) {
    const tokenResult = await getAccountToken();
    if (!tokenResult?.ok || !tokenResult.accessToken) return { ok: false, code: "ACCOUNT_LOGIN_REQUIRED" };
    return serviceFetch(pathname, {
      method: "POST",
      body: JSON.stringify({ deviceId: getDesktopDeviceId(), ...body }),
      headers: { Authorization: `Bearer ${tokenResult.accessToken}` },
    });
  }

  return {
    async createChallenge() {
      const res = await authedPost("/api/mobile/pairing/challenge");
      if (!res?.ok || !res.json?.ok) return failure(res, "PAIRING_CHALLENGE_FAILED");
      const qr = buildQrPayload({ serverBaseUrl: getServerBaseUrl(), token: res.json.token, desktopDeviceId: getDesktopDeviceId() });
      // Fail-open: without an image the page still shows the paste code.
      let image = "";
      if (qr.scanUrl) {
        try { image = String((await makeQrImage(qr.scanUrl)) || ""); }
        catch (err) { log.warn("qr image render failed, text code only: %s", err?.message || err); }
      }
      return { ok: true, challengeId: res.json.challengeId, expiresAt: res.json.expiresAt, qr: { ...qr, image } };
    },

    async createDirectCode() {
      const res = await authedPost("/api/mobile/direct/create");
      if (!res?.ok || !res.json?.ok) return failure(res, "DIRECT_CREATE_FAILED");
      return { ok: true, codeId: res.json.codeId, code: res.json.code, password: res.json.password, expiresAt: res.json.expiresAt };
    },

    async approve(grantId) {
      if (!grantId) return { ok: false, code: "PAIRING_APPROVE_INVALID" };
      const res = await authedPost("/api/mobile/pairing/approve", { grantId });
      return res?.ok && res.json?.ok ? { ok: true, grantId } : failure(res, "PAIRING_APPROVE_FAILED");
    },

    async deny(grantId) {
      if (!grantId) return { ok: false, code: "PAIRING_DENY_INVALID" };
      const res = await authedPost("/api/mobile/pairing/deny", { grantId });
      return res?.ok && res.json?.ok ? { ok: true, grantId } : failure(res, "PAIRING_DENY_FAILED");
    },

    async revoke(grantId, reason = "user_action") {
      if (!grantId) return { ok: false, code: "PAIRING_REVOKE_INVALID" };
      const res = await authedPost("/api/mobile/pairing/revoke", { grantId, reason });
      return res?.ok && res.json?.ok ? { ok: true, grantId } : failure(res, "PAIRING_REVOKE_FAILED");
    },

    /** What the server offers: phone capabilities and the relay protocols it speaks. */
    async capabilities() {
      const res = await serviceFetch("/api/mobile/capabilities", { method: "GET" });
      if (!res?.ok || !res.json?.ok) return failure(res, "MOBILE_CAPABILITIES_UNAVAILABLE");
      return {
        ok: true,
        capabilities: res.json.capabilities || {},
        controlChannel: Number(res.json.relay?.controlChannel || 0),
      };
    },
  };
}

module.exports = { buildQrPayload, createPairingApi };
