import { db } from "../db.js";
import { sha256, stableStringify, verifyDetachedPayload } from "./security.js";

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
  const valid = bindings
    .filter((binding) => {
      if (!binding?.license_id) return false;
      if (requested && binding.license_id !== requested) return false;
      if (binding.binding_status !== "active" || binding.license_status !== "active") return false;
      return licenseTime(binding.expires_at) > nowMs;
    })
    .sort((a, b) => {
      const lastSeenDelta = licenseTime(b.last_seen_at) - licenseTime(a.last_seen_at);
      if (lastSeenDelta) return lastSeenDelta;
      return licenseTime(b.activated_at) - licenseTime(a.activated_at);
    });
  return String(valid[0]?.license_id || "");
}

export async function validLicenseScope(input) {
  const licenseId = String(input.licenseId || "").trim();
  let query = db
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
    .where("license_devices.device_id", "=", input.deviceId);
  if (licenseId) query = query.where("license_devices.license_id", "=", licenseId);
  const bindings = await query
    .orderBy("license_devices.last_seen_at", "desc")
    .orderBy("license_devices.activated_at", "desc")
    .limit(licenseId ? 1 : 10)
    .execute();
  return chooseValidLicenseScope(bindings, licenseId);
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
