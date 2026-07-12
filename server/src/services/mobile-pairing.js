import crypto from "node:crypto";
import { sha256 } from "./security.js";
import { publicId } from "./ids.js";

// Mobile Command Phase 1-2 — pairing decision logic.
//
// The security-critical decisions (challenge issue/consume, compare-and-set
// grant approval, deny, revoke) live here as PURE, injectable functions: they
// take the already-authenticated identities plus DB callbacks, so the unit test
// drives every branch with mock callbacks and no Postgres. The fastify layer
// (server/src/routes/public/mobile.js) wires the real device-signature +
// account guards and the real Kysely queries onto these functions.
//
// Contract: docs/mobile-command-auth-identity-contract.md §4.1; tables:
// server/migrations/025_mobile_pairing.sql.

export const CHALLENGE_TTL_MS = 5 * 60_000; // §... challenge 5-minute TTL
export const GRANT_APPROVAL_TTL_MS = 2 * 60_000; // desktop approval within 2 min
const REVOKE_REASONS = new Set([
  "user_action",
  "account_revoked",
  "device_revoked",
  "license_revoked",
  "risk",
  "superseded",
]);

function asTime(value) {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** A fresh 256-bit opaque token — carried only in the QR/desktop memory; only
 *  its hash is ever stored (never returned again after creation). */
export function generatePairingToken() {
  return `mpt_${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashPairingToken(token) {
  return sha256(String(token || ""));
}

/**
 * Desktop issues a pairing challenge. Identities are pre-authenticated by the
 * route (account session + desktop device signature). Returns the RAW token
 * once; the caller puts it in the QR code and never stores it.
 */
export async function createPairingChallenge({
  userId,
  accountSessionId,
  desktopDeviceId,
  now = new Date(),
  insertChallenge,
  generateToken = generatePairingToken,
}) {
  if (!userId || !accountSessionId || !desktopDeviceId) {
    return { ok: false, code: "PAIRING_CHALLENGE_INVALID" };
  }
  const token = generateToken();
  const id = publicId("mpc");
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  await insertChallenge({
    id,
    user_id: userId,
    account_session_id: accountSessionId,
    desktop_device_id: desktopDeviceId,
    token_hash: hashPairingToken(token),
    status: "pending",
    expires_at: expiresAt.toISOString(),
    created_at: now.toISOString(),
  });
  return { ok: true, challengeId: id, token, expiresAt: expiresAt.toISOString() };
}

/**
 * Mobile consumes a challenge and creates a pending_approval grant. The
 * mobile identity (userId/sessionId/deviceId) comes from the mobile's own
 * authenticated account session; the challenge supplies the desktop side.
 *
 * - `casConsumeChallenge(tokenHash, now)` must atomically flip the row from
 *   pending→consumed and return the consumed row (or null if it was not an
 *   unexpired pending row). This closes the replay window.
 * - `resolveDesktopLicense(desktopDeviceId)` returns the license bound to the
 *   desktop device (grant's license composite FK).
 * - `insertGrant(row)` inserts the pending grant; a live-pair unique violation
 *   surfaces as code PAIRING_ALREADY_LIVE.
 */
export async function consumePairingChallenge({
  token,
  mobileUserId,
  mobileSessionId,
  mobileDeviceId,
  now = new Date(),
  casConsumeChallenge,
  resolveDesktopLicense,
  insertGrant,
}) {
  if (!token || !mobileUserId || !mobileSessionId || !mobileDeviceId) {
    return { ok: false, code: "PAIRING_CONSUME_INVALID" };
  }
  const challenge = await casConsumeChallenge(hashPairingToken(token), now);
  if (!challenge) return { ok: false, code: "PAIRING_CHALLENGE_INVALID_OR_EXPIRED" };
  // Same account only: the challenge and the consuming mobile session must
  // belong to the same user (contract line 68).
  if (challenge.user_id !== mobileUserId) {
    return { ok: false, code: "PAIRING_ACCOUNT_MISMATCH" };
  }
  if (challenge.desktop_device_id === mobileDeviceId) {
    return { ok: false, code: "PAIRING_SELF_PAIR" };
  }
  const licenseId = await resolveDesktopLicense(challenge.desktop_device_id);
  if (!licenseId) return { ok: false, code: "PAIRING_LICENSE_UNRESOLVED" };

  const grantId = publicId("mpg");
  const approvalExpiresAt = new Date(now.getTime() + GRANT_APPROVAL_TTL_MS);
  try {
    await insertGrant({
      id: grantId,
      user_id: mobileUserId,
      account_session_id: mobileSessionId,
      desktop_device_id: challenge.desktop_device_id,
      mobile_device_id: mobileDeviceId,
      license_id: licenseId,
      status: "pending_approval",
      approval_expires_at: approvalExpiresAt.toISOString(),
      created_at: now.toISOString(),
    });
  } catch (err) {
    if (isLivePairConflict(err)) return { ok: false, code: "PAIRING_ALREADY_LIVE" };
    throw err;
  }
  return {
    ok: true,
    grantId,
    desktopDeviceId: challenge.desktop_device_id,
    approvalExpiresAt: approvalExpiresAt.toISOString(),
  };
}

function isLivePairConflict(err) {
  const text = `${err?.code || ""} ${err?.constraint || ""} ${err?.message || ""}`;
  return /23505/.test(text) || /live_pair/.test(text);
}

/**
 * Desktop approves a pending grant. Compare-and-set from an unexpired
 * pending_approval row: two concurrent decisions can never both win, and an
 * approval that arrives after timeout/deny loses.
 *
 * `casApproveGrant({ grantId, desktopDeviceId, now })` must run
 *   UPDATE ... SET status='active', approved_at=now
 *   WHERE id=? AND desktop_device_id=? AND status='pending_approval'
 *        AND approval_expires_at > now
 * and return the number of rows updated.
 */
export async function approvePairingGrant({
  grantId,
  desktopDeviceId,
  now = new Date(),
  casApproveGrant,
}) {
  if (!grantId || !desktopDeviceId) return { ok: false, code: "PAIRING_APPROVE_INVALID" };
  const updated = await casApproveGrant({ grantId, desktopDeviceId, now });
  if (Number(updated || 0) !== 1) {
    return { ok: false, code: "PAIRING_NOT_PENDING" };
  }
  return { ok: true, grantId, status: "active" };
}

/** Desktop denies a pending grant (compare-and-set → denied, terminal_at set). */
export async function denyPairingGrant({
  grantId,
  desktopDeviceId,
  now = new Date(),
  casDenyGrant,
}) {
  if (!grantId || !desktopDeviceId) return { ok: false, code: "PAIRING_DENY_INVALID" };
  const updated = await casDenyGrant({ grantId, desktopDeviceId, now });
  if (Number(updated || 0) !== 1) return { ok: false, code: "PAIRING_NOT_PENDING" };
  return { ok: true, grantId, status: "denied" };
}

/**
 * Revoke an active (or pending) grant. Reason must be a bounded code (the
 * table forbids free-form secrets and only allows a reason on revoked rows).
 * `casRevokeGrant({ grantId, userId, reason, now })` sets status='revoked',
 * terminal_at, revoked_reason WHERE id=? AND user_id=? AND status IN
 * ('pending_approval','active'); returns rows updated.
 */
export async function revokePairingGrant({
  grantId,
  userId,
  reason = "user_action",
  now = new Date(),
  casRevokeGrant,
}) {
  if (!grantId || !userId) return { ok: false, code: "PAIRING_REVOKE_INVALID" };
  const code = REVOKE_REASONS.has(reason) ? reason : "user_action";
  const updated = await casRevokeGrant({ grantId, userId, reason: code, now });
  if (Number(updated || 0) !== 1) return { ok: false, code: "PAIRING_NOT_REVOCABLE" };
  return { ok: true, grantId, status: "revoked", reason: code };
}

export { asTime };
