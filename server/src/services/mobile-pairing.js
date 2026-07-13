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
 * Mobile consumes a challenge and creates a pending_approval grant. Desktop-
 * vouched model: the phone presents only a browser device id (no account login).
 * The grant's user_id is the DESKTOP (challenge) user, who vouches for the phone
 * by approving; security rests on the one-time QR token (proximity) + that human
 * approval. The phone gets a grant-scoped token (issued by the route layer via
 * `issueGrantToken`) whose only power is to connect the relay for this grant.
 *
 * - `casConsumeChallenge(tokenHash, now)` must atomically flip the row from
 *   pending→consumed and return the consumed row (or null if it was not an
 *   unexpired pending row). This closes the replay window.
 * - `resolveDesktopLicense(desktopDeviceId)` returns the license bound to the
 *   desktop device (grant's license composite FK).
 * - `supersedeLivePairs({ desktopDeviceId, mobileDeviceId, now })` (optional)
 *   revokes any existing live grant for this exact desktop↔mobile pair BEFORE
 *   inserting, so re-scanning always works: a lingering active/pending grant
 *   (which never auto-expires once active) would otherwise trip the live-pair
 *   unique index and permanently block the same phone from re-pairing.
 * - `insertGrant(row)` inserts the pending grant; a live-pair unique violation
 *   surfaces as code PAIRING_ALREADY_LIVE.
 * - `issueGrantToken({ grantId, mobileDeviceId })` mints the grant-scoped token
 *   returned to the phone (optional; omitted in tests that don't assert it).
 */
export async function consumePairingChallenge({
  token,
  mobileDeviceId,
  now = new Date(),
  casConsumeChallenge,
  resolveDesktopLicense,
  supersedeLivePairs,
  insertGrant,
  issueGrantToken,
}) {
  if (!token || !mobileDeviceId) {
    return { ok: false, code: "PAIRING_CONSUME_INVALID" };
  }
  const challenge = await casConsumeChallenge(hashPairingToken(token), now);
  if (!challenge) return { ok: false, code: "PAIRING_CHALLENGE_INVALID_OR_EXPIRED" };
  if (challenge.desktop_device_id === mobileDeviceId) {
    return { ok: false, code: "PAIRING_SELF_PAIR" };
  }
  const licenseId = await resolveDesktopLicense(challenge.desktop_device_id);
  if (!licenseId) return { ok: false, code: "PAIRING_LICENSE_UNRESOLVED" };

  const grantId = publicId("mpg");
  const approvalExpiresAt = new Date(now.getTime() + GRANT_APPROVAL_TTL_MS);
  // Re-scan supersedes: revoke any lingering live pairing for this exact
  // desktop↔mobile pair so the fresh grant can take the (single) live slot.
  if (typeof supersedeLivePairs === "function") {
    await supersedeLivePairs({ desktopDeviceId: challenge.desktop_device_id, mobileDeviceId, now });
  }
  try {
    await insertGrant({
      id: grantId,
      user_id: challenge.user_id, // the desktop user vouches for this phone
      account_session_id: null, // no mobile session in the vouched model
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
  const mobileToken = typeof issueGrantToken === "function"
    ? issueGrantToken({ grantId, mobileDeviceId })
    : "";
  return {
    ok: true,
    grantId,
    mobileToken,
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

/** Shape a pending grant row for the desktop approval list (opaque, no secrets). */
export function shapePendingGrant(row) {
  return {
    grantId: row.id,
    mobileDeviceId: row.mobile_device_id,
    approvalExpiresAt: row.approval_expires_at,
    createdAt: row.created_at,
  };
}

/**
 * Desktop polls its pending pairing requests. `listPending(desktopDeviceId,
 * nowIso)` returns unexpired pending_approval rows for this desktop. Pure
 * shaping so the response never leaks internal columns.
 */
export async function listPendingGrants({ desktopDeviceId, now = new Date(), listPending }) {
  if (!desktopDeviceId) return { ok: false, code: "PAIRING_PENDING_INVALID" };
  const rows = (await listPending(desktopDeviceId, now.toISOString())) || [];
  return { ok: true, grants: rows.map(shapePendingGrant) };
}

/** Shape a grant for the desktop's pairing-management list (status included). */
export function shapeGrant(row) {
  return {
    grantId: row.id,
    mobileDeviceId: row.mobile_device_id,
    status: row.status,
    approvalExpiresAt: row.approval_expires_at,
    approvedAt: row.approved_at || null,
    createdAt: row.created_at,
  };
}

/**
 * Desktop lists its live pairings (pending_approval + active) so the user can
 * see and revoke paired phones. `listGrants(desktopDeviceId, nowIso)` returns
 * the live rows for this desktop (expired pendings excluded).
 */
export async function listGrantsForDesktop({ desktopDeviceId, now = new Date(), listGrants }) {
  if (!desktopDeviceId) return { ok: false, code: "PAIRING_LIST_INVALID" };
  const rows = (await listGrants(desktopDeviceId, now.toISOString())) || [];
  return { ok: true, grants: rows.map(shapeGrant) };
}

export { asTime };
