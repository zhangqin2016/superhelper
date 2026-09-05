import crypto from "node:crypto";
import { publicId } from "./ids.js";

/**
 * Enterprise-issued accounts: a company generates dedicated logins for staff.
 *
 * Identity used to be phone-only, so an account could not exist unless the
 * person personally held a phone and completed SMS login. A company that had
 * bought seats could not hand any of them out. This adds a login-name +
 * password identity the company issues once; the employee must change the
 * password on first login, and the account is owned by the organization.
 *
 * Decision logic is pure and exported separately from the queries so the rules
 * can be held to account without a database.
 */

// ---------------------------------------------------------------- passwords

const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
// No 0/O/1/l/I: an initial password is read off a screen or a printout.
const INITIAL_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INITIAL_LENGTH = 12;

/** scrypt with a per-user random salt; Node built-in, no dependency. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/** Constant-time verify. A malformed stored hash verifies as false, never throws. */
export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, "base64");
    const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, "base64"), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** The one-time password the company hands to the employee. Never stored. */
export function generateInitialPassword() {
  let out = "";
  for (let i = 0; i < INITIAL_LENGTH; i += 1) out += INITIAL_ALPHABET[crypto.randomInt(INITIAL_ALPHABET.length)];
  return out;
}

/** @returns {{ ok: boolean, code?: string }} */
export function validateNewPassword(password) {
  const value = String(password || "");
  if (value.length < PASSWORD_MIN) return { ok: false, code: "PASSWORD_TOO_SHORT" };
  if (value.length > PASSWORD_MAX) return { ok: false, code: "PASSWORD_TOO_LONG" };
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) return { ok: false, code: "PASSWORD_TOO_SIMPLE" };
  return { ok: true };
}

// ---------------------------------------------------------------- login names

const LOGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

/** Lowercased and trimmed; "" when it cannot be a login name. */
export function normalizeLoginName(value) {
  const name = String(value || "").trim().toLowerCase();
  return LOGIN_NAME_RE.test(name) ? name : "";
}

/** `<org-prefix>-<6 chars>`, from a name the company chose for itself. */
export function generateLoginName(prefix) {
  const base = String(prefix || "org").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16) || "org";
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let tail = "";
  for (let i = 0; i < 6; i += 1) tail += alphabet[crypto.randomInt(alphabet.length)];
  return `${base}-${tail}`;
}

// ---------------------------------------------------------------- sequential batches

const PREFIX_RE = /^[a-z0-9][a-z0-9._-]{0,19}$/;
const SEQUENCE_MIN_WIDTH = 4;

/** Lowercased prefix, or "" when it cannot head a login name. */
export function normalizeLoginPrefix(value) {
  const prefix = String(value || "").trim().toLowerCase().replace(/[_-]+$/, "");
  return PREFIX_RE.test(prefix) ? prefix : "";
}

/**
 * `MAX` + 20 -> max_0001 .. max_0020, continuing from where the last batch
 * stopped. Pure: the caller supplies the numbers already in use.
 *
 * Width is at least 4 digits and grows if the sequence needs it, so a batch
 * never produces max_0999 followed by max_1000 with a different shape. Numbers
 * already taken (someone named an account max_0007 by hand) are skipped rather
 * than failed — a sequential fill should be robust, not brittle.
 *
 * @param {string} prefix       already normalised
 * @param {number} count        1..MAX_BATCH
 * @param {Iterable<number>} taken numbers already used under this prefix
 */
export function sequentialLoginNames(prefix, count, taken = []) {
  const used = new Set([...taken].map(Number).filter((n) => Number.isInteger(n) && n > 0));
  const start = used.size ? Math.max(...used) + 1 : 1;
  const wanted = Math.max(0, Math.min(Number(count) || 0, MAX_BATCH));
  const width = Math.max(SEQUENCE_MIN_WIDTH, String(start + wanted).length);
  const names = [];
  for (let n = start; names.length < wanted; n += 1) {
    if (used.has(n)) continue;
    names.push(`${prefix}_${String(n).padStart(width, "0")}`);
  }
  return names;
}

/** The sequence numbers already issued under a prefix in this organization. */
export async function takenSequenceNumbers(trx, { organizationId, prefix }) {
  const rows = await trx
    .selectFrom("users")
    .select("login_name")
    .where("provisioned_organization_id", "=", organizationId)
    .where("login_name", "like", `${prefix}\_%`)
    .execute();
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)$`);
  return rows
    .map((row) => re.exec(String(row.login_name || ""))?.[1])
    .filter(Boolean)
    .map(Number);
}

// ---------------------------------------------------------------- login decision

const LOCK_AFTER_FAILURES = 5;
const LOCK_MS = 15 * 60_000;

/**
 * Whether a password login attempt succeeds, and what to record.
 *
 * Pure. Mirrors the SMS path's "5 attempts then locked" so an issued account is
 * not a weaker door than a phone. The password check is passed in as a boolean
 * so the decision never touches a hash itself.
 *
 * @returns {{ ok: boolean, code?: string, failedCount: number, lockedUntil: number | null, mustChange?: boolean }}
 */
export function passwordLoginDecision({
  userStatus = "active",
  passwordOk = false,
  failedCount = 0,
  lockedUntil = null,
  mustChange = false,
  now = Date.now(),
} = {}) {
  const lockMs = lockedUntil ? new Date(lockedUntil).getTime() : 0;
  if (lockMs && lockMs > now) return { ok: false, code: "PASSWORD_LOCKED", failedCount, lockedUntil: lockMs };
  if (userStatus !== "active") return { ok: false, code: "USER_DISABLED", failedCount, lockedUntil: null };
  if (!passwordOk) {
    const nextFailed = Number(failedCount || 0) + 1;
    const locked = nextFailed >= LOCK_AFTER_FAILURES ? now + LOCK_MS : null;
    return { ok: false, code: locked ? "PASSWORD_LOCKED" : "INVALID_CREDENTIALS", failedCount: nextFailed, lockedUntil: locked };
  }
  return { ok: true, failedCount: 0, lockedUntil: null, mustChange: Boolean(mustChange) };
}

/**
 * Should removing / disabling this membership also lock the login?
 *
 * Pure. An account the company issued belongs to the company: taking it out of
 * the org means the person can no longer log in at all. A phone user who merely
 * joined an org keeps their own account.
 */
export function ownedAccountStatusAfterMembership({ provisionedOrganizationId = null, organizationId, memberStatus }) {
  if (!provisionedOrganizationId || provisionedOrganizationId !== organizationId) return null;
  return memberStatus === "active" ? "active" : "disabled";
}

// ---------------------------------------------------------------- provisioning

const MAX_BATCH = 100;

/**
 * Create issued accounts inside an existing organization transaction.
 *
 * `trx` must already hold the organization lock (the enterprise mutation
 * service does). Returns the initial passwords ONCE; they are not persisted.
 *
 * @param {Array<{ loginName?: string, displayName?: string, role?: "admin"|"member" }>} requests
 */
export async function provisionAccounts(trx, { organizationId, organizationName, requests, pattern, provisionedBy, allowOwner = false }) {
  let list = Array.isArray(requests) ? requests.slice(0, MAX_BATCH) : [];
  // `MAX` + 20 -> max_0001..max_0020, continuing after the last batch. Resolved
  // here, under the organization lock the caller already holds, so two admins
  // issuing at once cannot both take max_0001.
  if (pattern && pattern.prefix) {
    const prefix = normalizeLoginPrefix(pattern.prefix);
    if (!prefix) {
      const error = new Error("INVALID_LOGIN_PREFIX");
      error.code = "INVALID_LOGIN_PREFIX";
      error.statusCode = 400;
      throw error;
    }
    const taken = await takenSequenceNumbers(trx, { organizationId, prefix });
    const role = pattern.role === "admin" ? "admin" : "member";
    list = sequentialLoginNames(prefix, pattern.count, taken).map((loginName) => ({ loginName, role }));
  }
  const issued = [];
  for (const request of list) {
    // Owner is only issuable by the platform admin at the moment it creates the
    // organization (the initial handoff). Every other caller gets member/admin.
    const role = request?.role === "owner" && allowOwner ? "owner" : request?.role === "admin" ? "admin" : "member";
    let loginName = normalizeLoginName(request?.loginName);
    if (request?.loginName && !loginName) {
      const error = new Error("INVALID_LOGIN_NAME");
      error.code = "INVALID_LOGIN_NAME";
      error.statusCode = 400;
      throw error;
    }
    // Auto-generate when none given; retry on the rare collision.
    for (let attempt = 0; attempt < 5 && !loginName; attempt += 1) {
      const candidate = generateLoginName(organizationName);
      const taken = await trx.selectFrom("users").select("id").where("login_name", "=", candidate).executeTakeFirst();
      if (!taken) loginName = candidate;
    }
    if (!loginName) {
      const error = new Error("LOGIN_NAME_UNAVAILABLE");
      error.code = "LOGIN_NAME_UNAVAILABLE";
      error.statusCode = 409;
      throw error;
    }
    const taken = await trx.selectFrom("users").select("id").where("login_name", "=", loginName).executeTakeFirst();
    if (taken) {
      const error = new Error("LOGIN_NAME_TAKEN");
      error.code = "LOGIN_NAME_TAKEN";
      error.statusCode = 409;
      throw error;
    }
    const initialPassword = generateInitialPassword();
    const userId = publicId("usr");
    await trx
      .insertInto("users")
      .values({
        id: userId,
        phone_e164: null,
        login_name: loginName,
        display_name: String(request?.displayName || "").trim().slice(0, 80) || null,
        password_hash: hashPassword(initialPassword),
        password_must_change: true,
        provisioned_organization_id: organizationId,
        status: "active",
      })
      .execute();
    await trx
      .insertInto("organization_members")
      .values({ organization_id: organizationId, user_id: userId, role, status: "active", quota: null })
      .execute();
    issued.push({ userId, loginName, displayName: request?.displayName || null, role, initialPassword, provisionedBy: provisionedBy || null });
  }
  return issued;
}

/** Issue a fresh one-time password; the old one stops working immediately. */
export async function resetIssuedPassword(trx, { organizationId, userId }) {
  const user = await trx
    .selectFrom("users")
    .select(["id", "login_name", "provisioned_organization_id"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!user || user.provisioned_organization_id !== organizationId) {
    const error = new Error("ACCOUNT_NOT_FOUND");
    error.code = "ACCOUNT_NOT_FOUND";
    error.statusCode = 404;
    throw error;
  }
  const initialPassword = generateInitialPassword();
  await trx
    .updateTable("users")
    .set({ password_hash: hashPassword(initialPassword), password_must_change: true, password_failed_count: 0, password_locked_until: null })
    .where("id", "=", userId)
    .execute();
  await trx.updateTable("user_sessions").set({ revoked_at: new Date().toISOString() })
    .where("user_id", "=", userId).where("revoked_at", "is", null).execute();
  return { userId, loginName: user.login_name, initialPassword };
}

export const ENTERPRISE_ACCOUNT_LIMITS = Object.freeze({ MAX_BATCH, PASSWORD_MIN, PASSWORD_MAX, LOCK_AFTER_FAILURES, LOCK_MS });
