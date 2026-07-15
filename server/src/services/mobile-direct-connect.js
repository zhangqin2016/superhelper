import crypto from "node:crypto";
import { config } from "../config.js";
import { publicId } from "./ids.js";

// Direct-connect codes (TeamViewer/ToDesk-style): the desktop shows a short code
// + password; the phone types both and connects directly (no approval). Short
// codes are low-entropy, so safety rests on: only hashes stored, per-code
// attempt lockout, short TTL, one active code per desktop, and the app's per-IP
// rate limit on the consume route. The security decisions are pure + unit-tested;
// the route layer supplies the real DB IO.

// No ambiguous chars (0/O/1/I/L). ~32-symbol alphabet ≈ 5 bits/char.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 8; // ~40 bits
export const PASSWORD_LENGTH = 6; // ~30 bits
export const DIRECT_CODE_TTL_MS = 30 * 60_000; // 30 min
export const GRANT_APPROVAL_TTL_MS = 2 * 60_000;
export const MAX_ATTEMPTS = 5;
export const LOCK_MS = 15 * 60_000;

function randomFromAlphabet(len) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function generateDirectCode() { return randomFromAlphabet(CODE_LENGTH); }
export function generateDirectPassword() { return randomFromAlphabet(PASSWORD_LENGTH); }

// Normalize user input: uppercase, strip spaces/dashes (users mistype casing).
export function normalizeDirectInput(value) {
  return String(value || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function pepper() { return process.env.MOBILE_DIRECT_PEPPER || config.sessionSecret; }
export function hashDirectSecret(value) {
  return crypto.createHmac("sha256", pepper()).update(`mdc|${normalizeDirectInput(value)}`).digest("hex");
}

/**
 * Desktop creates a direct-connect code. Revokes any prior active code for this
 * desktop first (one active at a time). Returns the plaintext code + password
 * ONCE (only hashes are persisted).
 */
export async function createDirectCode({
  userId,
  accountSessionId,
  desktopDeviceId,
  now = new Date(),
  revokePriorActive, // async ({ desktopDeviceId, now })
  insertCode, // async (row)
  makeCode = generateDirectCode,
  makePassword = generateDirectPassword,
}) {
  if (!userId || !desktopDeviceId) return { ok: false, code: "DIRECT_CREATE_INVALID" };
  if (typeof revokePriorActive === "function") {
    await revokePriorActive({ desktopDeviceId, now });
  }
  const code = makeCode();
  const password = makePassword();
  const id = publicId("mdc");
  const expiresAt = new Date(now.getTime() + DIRECT_CODE_TTL_MS);
  await insertCode({
    id,
    user_id: userId,
    account_session_id: accountSessionId || null,
    desktop_device_id: desktopDeviceId,
    code_hash: hashDirectSecret(code),
    password_hash: hashDirectSecret(password),
    status: "active",
    attempt_count: 0,
    expires_at: expiresAt.toISOString(),
    created_at: now.toISOString(),
  });
  return { ok: true, codeId: id, code, password, expiresAt: expiresAt.toISOString() };
}

/**
 * Phone consumes a direct code+password → an ACTIVE grant + relay token, no
 * approval. Rate-limited per code (lockout after MAX_ATTEMPTS). The code stays
 * usable within its TTL so the phone can reconnect after a drop (ToDesk-style);
 * the desktop regenerating invalidates it.
 *
 * Injected IO:
 *  - findActiveCodeByHash(codeHash, nowIso) → active, unexpired row | null
 *  - registerFailedAttempt({ id, attemptCount, now }) → set attempt_count (+ lock)
 *  - resetAttempts({ id, now }) → clear attempt_count on success
 *  - resolveDesktopLicense(desktopDeviceId) → licenseId | null
 *  - supersedeLivePairs({ desktopDeviceId, mobileDeviceId, now })
 *  - insertGrant(row); issueGrantToken({ grantId, mobileDeviceId })
 */
export async function consumeDirectCode({
  code,
  password,
  mobileDeviceId,
  now = new Date(),
  findActiveCodeByHash,
  registerFailedAttempt,
  resetAttempts,
  resolveDesktopLicense,
  supersedeLivePairs,
  insertGrant,
  issueGrantToken,
}) {
  if (!code || !password || !mobileDeviceId) return { ok: false, code: "DIRECT_CONSUME_INVALID" };
  const row = await findActiveCodeByHash(hashDirectSecret(code), now.toISOString());
  // Same opaque error whether the code doesn't exist or the password is wrong,
  // so an attacker can't enumerate valid codes.
  if (!row) return { ok: false, code: "DIRECT_CODE_INVALID" };
  if (row.locked_until && new Date(row.locked_until).getTime() > now.getTime()) {
    return { ok: false, code: "DIRECT_CODE_LOCKED", lockedUntil: row.locked_until };
  }
  if (hashDirectSecret(password) !== row.password_hash) {
    const attemptCount = Number(row.attempt_count || 0) + 1;
    const lock = attemptCount >= MAX_ATTEMPTS;
    if (typeof registerFailedAttempt === "function") {
      await registerFailedAttempt({
        id: row.id,
        attemptCount,
        lockedUntil: lock ? new Date(now.getTime() + LOCK_MS).toISOString() : null,
        now,
      });
    }
    return { ok: false, code: lock ? "DIRECT_CODE_LOCKED" : "DIRECT_CODE_INVALID", remaining: Math.max(0, MAX_ATTEMPTS - attemptCount) };
  }
  if (row.desktop_device_id === mobileDeviceId) return { ok: false, code: "DIRECT_SELF_PAIR" };
  const licenseId = await resolveDesktopLicense(row.desktop_device_id);
  if (!licenseId) return { ok: false, code: "DIRECT_LICENSE_UNRESOLVED" };

  if (typeof supersedeLivePairs === "function") {
    await supersedeLivePairs({ desktopDeviceId: row.desktop_device_id, mobileDeviceId, now });
  }
  const grantId = publicId("mpg");
  try {
    await insertGrant({
      id: grantId,
      user_id: row.user_id,
      account_session_id: null,
      desktop_device_id: row.desktop_device_id,
      mobile_device_id: mobileDeviceId,
      license_id: licenseId,
      status: "active", // direct connect: active immediately, no approval
      approved_at: now.toISOString(),
      approval_expires_at: new Date(now.getTime() + GRANT_APPROVAL_TTL_MS).toISOString(),
      created_at: now.toISOString(),
    });
  } catch (err) {
    if (String(err?.code) === "23505") return { ok: false, code: "PAIRING_ALREADY_LIVE" };
    throw err;
  }
  if (typeof resetAttempts === "function") await resetAttempts({ id: row.id, now });
  const mobileToken = typeof issueGrantToken === "function" ? issueGrantToken({ grantId, mobileDeviceId }) : "";
  return { ok: true, grantId, mobileToken, desktopDeviceId: row.desktop_device_id };
}
