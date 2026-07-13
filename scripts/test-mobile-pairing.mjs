#!/usr/bin/env node
// Mobile Command Phase 1-2 pairing decision logic. Security-critical: a wrong
// branch here means a stranger pairs to a desktop or a replay wins. The logic
// is pure/injectable so every branch runs with mock callbacks — no Postgres.

import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-abcdefghijklmnop";
process.env.DATABASE_URL ||= "postgres://localhost:5432/test";

const {
  createPairingChallenge,
  consumePairingChallenge,
  approvePairingGrant,
  denyPairingGrant,
  revokePairingGrant,
  listPendingGrants,
  shapePendingGrant,
  hashPairingToken,
  generatePairingToken,
  CHALLENGE_TTL_MS,
  GRANT_APPROVAL_TTL_MS,
} = await import("../server/src/services/mobile-pairing.js");

const NOW = new Date("2026-07-12T12:00:00.000Z");

// --- token hashing: raw token never leaks, hash is stable --------------------
{
  const t = generatePairingToken();
  assert.match(t, /^mpt_/, "token is opaque with a namespace prefix");
  assert.equal(hashPairingToken(t), hashPairingToken(t), "hash is stable");
  assert.notEqual(hashPairingToken(t), t, "the stored value is a hash, not the raw token");
  assert.equal(hashPairingToken("a").length, 64, "sha256 hex");
}

// --- createPairingChallenge --------------------------------------------------
{
  let inserted = null;
  const res = await createPairingChallenge({
    userId: "u1",
    accountSessionId: "sess_desktop",
    desktopDeviceId: "dtop",
    now: NOW,
    insertChallenge: async (row) => { inserted = row; },
    generateToken: () => "mpt_fixed",
  });
  assert.equal(res.ok, true);
  assert.equal(res.token, "mpt_fixed", "raw token returned once to the caller");
  assert.equal(inserted.token_hash, hashPairingToken("mpt_fixed"), "only the HASH is stored");
  assert.equal(inserted.status, "pending");
  assert.equal(inserted.desktop_device_id, "dtop");
  assert.equal(
    new Date(inserted.expires_at).getTime() - NOW.getTime(),
    CHALLENGE_TTL_MS,
    "challenge carries the 5-minute TTL",
  );

  const missing = await createPairingChallenge({ userId: "", accountSessionId: "s", desktopDeviceId: "d", insertChallenge: async () => {} });
  assert.equal(missing.ok, false, "missing identity is rejected");
}

// --- consumePairingChallenge -------------------------------------------------
function pendingChallenge(overrides = {}) {
  return {
    id: "mpc_1",
    user_id: "u1",
    account_session_id: "sess_desktop",
    desktop_device_id: "dtop",
    status: "consumed",
    ...overrides,
  };
}

{
  // happy path (desktop-vouched, NO mobile login): challenge consumed atomically,
  // pending grant created with the DESKTOP user vouching, no mobile session, and
  // a grant-scoped token minted for the phone.
  let grant = null;
  const res = await consumePairingChallenge({
    token: "mpt_fixed",
    mobileDeviceId: "dmob",
    now: NOW,
    casConsumeChallenge: async (hash) => {
      assert.equal(hash, hashPairingToken("mpt_fixed"), "consume looks up by hash");
      return pendingChallenge();
    },
    resolveDesktopLicense: async (dev) => (dev === "dtop" ? "lic1" : null),
    insertGrant: async (row) => { grant = row; },
    issueGrantToken: ({ grantId, mobileDeviceId }) => `gt_${grantId}_${mobileDeviceId}`,
  });
  assert.equal(res.ok, true);
  assert.equal(grant.status, "pending_approval");
  assert.equal(grant.desktop_device_id, "dtop");
  assert.equal(grant.mobile_device_id, "dmob");
  assert.equal(grant.license_id, "lic1");
  assert.equal(grant.user_id, "u1", "grant.user_id is the DESKTOP (challenge) user who vouches");
  assert.equal(grant.account_session_id, null, "no mobile session in the vouched model");
  assert.equal(res.mobileToken, `gt_${grant.id}_dmob`, "a grant-scoped token is minted for the phone");
  assert.equal(
    new Date(grant.approval_expires_at).getTime() - NOW.getTime(),
    GRANT_APPROVAL_TTL_MS,
    "grant carries the 2-minute approval window",
  );

  // missing device id / token → invalid
  const invalid = await consumePairingChallenge({
    token: "", mobileDeviceId: "dmob",
    casConsumeChallenge: async () => { throw new Error("must not consume without a token"); },
  });
  assert.equal(invalid.code, "PAIRING_CONSUME_INVALID");

  // replay / expired / already-consumed: CAS returns null → rejected
  const replay = await consumePairingChallenge({
    token: "mpt_fixed", mobileDeviceId: "dmob",
    casConsumeChallenge: async () => null,
    resolveDesktopLicense: async () => "lic1",
    insertGrant: async () => { throw new Error("must not insert on failed consume"); },
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, "PAIRING_CHALLENGE_INVALID_OR_EXPIRED", "a spent/expired challenge cannot pair");

  // self-pair: mobile device == desktop device
  const selfPair = await consumePairingChallenge({
    token: "mpt_fixed", mobileDeviceId: "dtop",
    casConsumeChallenge: async () => pendingChallenge(),
    resolveDesktopLicense: async () => "lic1",
    insertGrant: async () => { throw new Error("must not self-pair"); },
  });
  assert.equal(selfPair.code, "PAIRING_SELF_PAIR");

  // license unresolved
  const noLicense = await consumePairingChallenge({
    token: "mpt_fixed", mobileDeviceId: "dmob",
    casConsumeChallenge: async () => pendingChallenge(),
    resolveDesktopLicense: async () => null,
    insertGrant: async () => { throw new Error("must not insert without license"); },
  });
  assert.equal(noLicense.code, "PAIRING_LICENSE_UNRESOLVED");

  // live-pair conflict: insert hits the partial unique
  const dup = await consumePairingChallenge({
    token: "mpt_fixed", mobileDeviceId: "dmob",
    casConsumeChallenge: async () => pendingChallenge(),
    resolveDesktopLicense: async () => "lic1",
    insertGrant: async () => { const e = new Error("dup"); e.code = "23505"; e.constraint = "mobile_pairing_grants_live_pair_uk"; throw e; },
  });
  assert.equal(dup.code, "PAIRING_ALREADY_LIVE", "a second live pairing for the same pair is refused");
}

// --- approve: compare-and-set, concurrent decisions cannot both win ----------
{
  const ok = await approvePairingGrant({
    grantId: "mpg_1", desktopDeviceId: "dtop", now: NOW,
    casApproveGrant: async ({ grantId, desktopDeviceId }) => {
      assert.equal(grantId, "mpg_1");
      assert.equal(desktopDeviceId, "dtop");
      return 1;
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, "active");

  // CAS matched 0 rows: already denied/expired/approved by a concurrent racer
  const lost = await approvePairingGrant({
    grantId: "mpg_1", desktopDeviceId: "dtop",
    casApproveGrant: async () => 0,
  });
  assert.equal(lost.ok, false);
  assert.equal(lost.code, "PAIRING_NOT_PENDING", "an approval after timeout/deny loses");

  // wrong desktop device cannot approve (CAS where clause misses)
  const wrongDevice = await approvePairingGrant({
    grantId: "mpg_1", desktopDeviceId: "other", casApproveGrant: async () => 0,
  });
  assert.equal(wrongDevice.code, "PAIRING_NOT_PENDING");
}

// --- deny + revoke -----------------------------------------------------------
{
  const denied = await denyPairingGrant({ grantId: "mpg_1", desktopDeviceId: "dtop", casDenyGrant: async () => 1 });
  assert.equal(denied.status, "denied");
  const denyMiss = await denyPairingGrant({ grantId: "mpg_1", desktopDeviceId: "dtop", casDenyGrant: async () => 0 });
  assert.equal(denyMiss.code, "PAIRING_NOT_PENDING");

  let seenReason = null;
  const revoked = await revokePairingGrant({
    grantId: "mpg_1", userId: "u1", reason: "device_revoked",
    casRevokeGrant: async ({ reason }) => { seenReason = reason; return 1; },
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(seenReason, "device_revoked", "a known revoke reason passes through");

  // unknown reason is normalized to the bounded default (no free-form secrets)
  const revokedDefault = await revokePairingGrant({
    grantId: "mpg_1", userId: "u1", reason: "secret-leak-details-here",
    casRevokeGrant: async ({ reason }) => { seenReason = reason; return 1; },
  });
  assert.equal(seenReason, "user_action", "an unbounded reason is normalized to a safe code");
  assert.equal(revokedDefault.reason, "user_action");

  const notRevocable = await revokePairingGrant({ grantId: "x", userId: "u1", casRevokeGrant: async () => 0 });
  assert.equal(notRevocable.code, "PAIRING_NOT_REVOCABLE", "a terminal grant cannot be revoked again");
}

// --- listPendingGrants: desktop polls its pending requests -------------------
{
  const shaped = shapePendingGrant({ id: "mpg_1", mobile_device_id: "dmob", approval_expires_at: "2026-07-12T12:02:00.000Z", created_at: "2026-07-12T12:00:00.000Z", user_id: "u1", license_id: "lic1" });
  assert.deepEqual(shaped, { grantId: "mpg_1", mobileDeviceId: "dmob", approvalExpiresAt: "2026-07-12T12:02:00.000Z", createdAt: "2026-07-12T12:00:00.000Z" }, "the pending view exposes no internal columns (no user_id/license_id)");

  let queriedDevice = null;
  const res = await listPendingGrants({
    desktopDeviceId: "dtop",
    listPending: async (deviceId) => { queriedDevice = deviceId; return [{ id: "mpg_1", mobile_device_id: "dmob", approval_expires_at: "x", created_at: "y" }]; },
  });
  assert.equal(res.ok, true);
  assert.equal(queriedDevice, "dtop", "pending is scoped to the desktop's own device");
  assert.equal(res.grants.length, 1);
  assert.equal(res.grants[0].grantId, "mpg_1");

  const bad = await listPendingGrants({ desktopDeviceId: "", listPending: async () => { throw new Error("must not query"); } });
  assert.equal(bad.ok, false, "missing desktop device is rejected");
}

console.log("mobile-pairing: ok");
