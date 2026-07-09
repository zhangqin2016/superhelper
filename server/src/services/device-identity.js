import { db } from "../db.js";
import { publicId } from "./ids.js";
import { sha256, stableStringify, verifyDetachedPayload } from "./security.js";

// A device fingerprint shared by more than this many distinct devices is treated
// as too ambiguous to auto-adopt a license from (e.g. a coarse/collision-prone
// fingerprint across an imaged corporate fleet). Recovery is skipped for such
// buckets and the user re-activates manually. With a strong hardware-derived
// fingerprint real buckets are ~1, so this only guards against soft-fingerprint
// collisions during the transition.
const MAX_FINGERPRINT_RECOVERY_BUCKET = Number(process.env.FINGERPRINT_RECOVERY_MAX_BUCKET || 8);

export async function upsertDevicePublicKey(input) {
  const publicKey = String(input.publicKey || "").trim();
  if (!publicKey) return;
  await db
    .insertInto("device_public_keys")
    .values({
      device_id: input.deviceId,
      public_key: publicKey,
      key_alg: String(input.keyAlg || "ed25519").trim() || "ed25519",
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column("device_id").doUpdateSet({
        public_key: publicKey,
        key_alg: String(input.keyAlg || "ed25519").trim() || "ed25519",
        updated_at: new Date(),
      }),
    )
    .execute();
}

export async function setDevicePublicKey(deviceId, publicKey, keyAlg = "ed25519") {
  await upsertDevicePublicKey({
    deviceId,
    publicKey,
    keyAlg,
  });
}

function headerValue(request, name) {
  return String(request.headers[name.toLowerCase()] || "").trim();
}

function requestBodyHash(body) {
  return sha256(body && typeof body === "object" ? stableStringify(body) : "");
}

export async function verifySignedDeviceRequest(request, input) {
  const deviceId = String(input?.deviceId || "").trim();
  const headerDeviceId = headerValue(request, "x-lily-device-id");
  if (!deviceId || headerDeviceId !== deviceId) {
    return { ok: false, code: "DEVICE_SIGNATURE_REQUIRED" };
  }

  const timestamp = headerValue(request, "x-lily-timestamp");
  const nonce = headerValue(request, "x-lily-nonce");
  const bodyHash = headerValue(request, "x-lily-body-sha256");
  const signature = headerValue(request, "x-lily-signature");
  if (!timestamp || !nonce || !bodyHash || !signature) {
    return { ok: false, code: "DEVICE_SIGNATURE_REQUIRED" };
  }

  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
    return { ok: false, code: "DEVICE_SIGNATURE_EXPIRED" };
  }
  if (bodyHash !== requestBodyHash(request.body)) {
    return { ok: false, code: "DEVICE_SIGNATURE_BODY_MISMATCH" };
  }

  const key = await db
    .selectFrom("device_public_keys")
    .selectAll()
    .where("device_id", "=", deviceId)
    .executeTakeFirst();
  if (!key?.public_key) return { ok: false, code: "DEVICE_KEY_NOT_REGISTERED" };

  const canonical = {
    method: request.method.toUpperCase(),
    pathname: request.url.split("?")[0],
    timestamp,
    nonce,
    bodyHash,
  };
  if (!verifyDetachedPayload(canonical, signature, key.public_key)) {
    return { ok: false, code: "DEVICE_SIGNATURE_INVALID" };
  }

  try {
    await db
      .deleteFrom("request_nonces")
      .where("created_at", "<", new Date(Date.now() - 10 * 60 * 1000))
      .execute();
    await db
      .insertInto("request_nonces")
      .values({ device_id: deviceId, nonce })
      .execute();
  } catch {
    return { ok: false, code: "DEVICE_SIGNATURE_REPLAYED" };
  }
  return { ok: true };
}

export async function requireSignedDeviceRequest(request, reply, input) {
  const signed = await verifySignedDeviceRequest(request, input);
  if (signed.ok) return true;
  reply.code(401).send({ ok: false, code: signed.code });
  return false;
}

function licenseTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function chooseValidLicenseScope(bindings = [], requestedLicenseId = "", nowMs = Date.now()) {
  const requested = String(requestedLicenseId || "").trim();
  // Any binding on THIS device that is currently active (binding + license) and
  // not expired. Note we do NOT drop non-requested bindings here — an activated
  // device must be able to fall back to its own other valid license when the
  // client's cached licenseId is stale (renewed/rebound card).
  const valid = bindings
    .filter((binding) => {
      if (!binding?.license_id) return false;
      if (binding.binding_status !== "active" || binding.license_status !== "active") return false;
      return licenseTime(binding.expires_at) > nowMs;
    })
    .sort((a, b) => {
      const lastSeenDelta = licenseTime(b.last_seen_at) - licenseTime(a.last_seen_at);
      if (lastSeenDelta) return lastSeenDelta;
      return licenseTime(b.activated_at) - licenseTime(a.activated_at);
    });
  // Honor the client's requested license when it is still valid; otherwise fall
  // back to the device's best remaining valid binding. Guarantee: an activated
  // device is never denied just because its cached licenseId went stale.
  const preferred = requested ? valid.find((binding) => binding.license_id === requested) : null;
  return String((preferred || valid[0])?.license_id || "");
}

export async function validLicenseScope(input) {
  const licenseId = String(input.licenseId || "").trim();
  // Always load ALL of the device's bindings (never pre-filter to the requested
  // licenseId at the DB level) so chooseValidLicenseScope can fall back to the
  // device's other valid license when the client's cached id is stale.
  const bindings = await db
    .selectFrom("license_devices")
    .leftJoin("licenses", "licenses.id", "license_devices.license_id")
    .select([
      "license_devices.license_id",
      "license_devices.status as binding_status",
      "license_devices.activated_at",
      "license_devices.last_seen_at",
      "licenses.status as license_status",
      "licenses.expires_at",
    ])
    .where("license_devices.device_id", "=", input.deviceId)
    .orderBy("license_devices.last_seen_at", "desc")
    .orderBy("license_devices.activated_at", "desc")
    .limit(10)
    .execute();
  return chooseValidLicenseScope(bindings, licenseId);
}

// Pure decision: given the valid license bindings held by OTHER devices that
// share this device's fingerprint, plus each license's seat usage, pick the
// license this device should adopt. Prefers most-recently-seen; only adopts when
// the license still has a free seat (active bindings < seats). Returns the
// chosen { licenseId } or null. Kept pure so the seat/bucket rules are testable.
export function chooseFingerprintRecoveryLicense(candidates = [], options = {}) {
  const bucketDeviceCount = Number(options.bucketDeviceCount || 0);
  const maxBucket = Number(options.maxBucket || MAX_FINGERPRINT_RECOVERY_BUCKET);
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  // Too many distinct devices behind one fingerprint → ambiguous, do not adopt.
  if (bucketDeviceCount > maxBucket) return null;
  const byLicense = new Map();
  for (const row of candidates) {
    if (!row?.license_id) continue;
    if (row.binding_status !== "active" || row.license_status !== "active") continue;
    if (licenseTime(row.expires_at) <= nowMs) continue;
    const prev = byLicense.get(row.license_id);
    const seats = Math.max(0, Math.trunc(Number(row.seats || 0)));
    const activeBindings = Math.max(0, Math.trunc(Number(row.active_bindings || 0)));
    const lastSeen = licenseTime(row.last_seen_at);
    if (!prev || lastSeen > prev.lastSeen) {
      byLicense.set(row.license_id, { licenseId: row.license_id, seats, activeBindings, lastSeen });
    }
  }
  const ordered = [...byLicense.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  // Adopt the freshest license that still has a free seat.
  const pick = ordered.find((entry) => entry.seats > 0 && entry.activeBindings < entry.seats);
  return pick ? { licenseId: pick.licenseId } : null;
}

// When a device's own deviceId has no valid binding (typically because a
// reinstall / data reset regenerated the client-stored random deviceId), try to
// recover the license from another device sharing the same hardware fingerprint,
// and adopt it by binding the current deviceId — respecting the license seat
// limit. Returns the recovered licenseId or "". Never throws.
export async function recoverLicenseScopeByFingerprint(input, nowMs = Date.now()) {
  const deviceId = String(input?.deviceId || "").trim();
  const fingerprintHash = String(input?.fingerprintHash || "").trim();
  if (!deviceId || !fingerprintHash) return "";
  try {
    const bucket = await db
      .selectFrom("devices")
      .select((eb) => eb.fn.count("id").as("count"))
      .where("fingerprint_hash", "=", fingerprintHash)
      .where("id", "<>", deviceId)
      .executeTakeFirst();
    const bucketDeviceCount = Number(bucket?.count || 0);
    if (bucketDeviceCount === 0 || bucketDeviceCount > MAX_FINGERPRINT_RECOVERY_BUCKET) return "";

    const candidates = await db
      .selectFrom("license_devices as ld")
      .innerJoin("devices as d", "d.id", "ld.device_id")
      .innerJoin("licenses as l", "l.id", "ld.license_id")
      .select((eb) => [
        "ld.license_id",
        "ld.status as binding_status",
        "ld.last_seen_at",
        "l.status as license_status",
        "l.expires_at",
        "l.seats",
        eb
          .selectFrom("license_devices as lc")
          .select((eb2) => eb2.fn.count("lc.id").as("c"))
          .whereRef("lc.license_id", "=", "ld.license_id")
          .where("lc.status", "=", "active")
          .as("active_bindings"),
      ])
      .where("d.fingerprint_hash", "=", fingerprintHash)
      .where("d.id", "<>", deviceId)
      .execute();

    const choice = chooseFingerprintRecoveryLicense(candidates, { bucketDeviceCount, nowMs });
    if (!choice) return "";

    // Idempotent adopt: reuse an existing binding for this device if present,
    // otherwise create one. A pre-existing disabled binding is left untouched.
    const existing = await db
      .selectFrom("license_devices")
      .select(["id", "status"])
      .where("license_id", "=", choice.licenseId)
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    if (existing) return existing.status === "active" ? choice.licenseId : "";
    await db
      .insertInto("license_devices")
      .values({ id: publicId("ldev"), license_id: choice.licenseId, device_id: deviceId })
      .execute();
    return choice.licenseId;
  } catch {
    // Recovery is best-effort — never block config delivery on it.
    return "";
  }
}

async function getTrialDays() {
  const row = await db
    .selectFrom("app_settings")
    .select("value")
    .where("key", "=", "license_trial_days")
    .executeTakeFirst();
  const parsed = Number(row?.value ?? 3);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(0, Math.min(3650, Math.trunc(parsed)));
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function trialPayload(device) {
  const endsAt = device?.trial_ends_at ? new Date(device.trial_ends_at) : null;
  const expiresAt = endsAt && Number.isFinite(endsAt.getTime()) ? endsAt.toISOString() : "";
  return {
    enabled: Boolean(expiresAt),
    valid: Boolean(expiresAt && endsAt.getTime() > Date.now()),
    expiresAt,
  };
}

export async function upsertDevice(input) {
  const existing = await db
    .selectFrom("devices")
    .selectAll()
    .where("id", "=", input.deviceId)
    .executeTakeFirst();
  const trialDays = existing ? 0 : await getTrialDays();
  const firstSeenAt = new Date();
  const trialEndsAt = trialDays > 0 ? addDays(firstSeenAt, trialDays) : null;

  await db
    .insertInto("devices")
    .values({
      id: input.deviceId,
      fingerprint_hash: input.fingerprintHash || null,
      platform: input.platform || null,
      arch: input.arch || null,
      app_version: input.appVersion || null,
      ...(trialEndsAt ? { trial_ends_at: trialEndsAt } : {}),
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        fingerprint_hash: input.fingerprintHash || null,
        platform: input.platform || null,
        arch: input.arch || null,
        app_version: input.appVersion || null,
        last_seen_at: new Date(),
      }),
    )
    .execute();

  return db
    .selectFrom("devices")
    .selectAll()
    .where("id", "=", input.deviceId)
    .executeTakeFirst();
}
