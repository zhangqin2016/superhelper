#!/usr/bin/env node
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/lily_test";

const { chooseValidLicenseScope, chooseFingerprintRecoveryLicense } = await import("../server/src/services/device-identity.js");

const now = Date.parse("2026-07-08T12:00:00.000Z");
const bindings = [
  {
    license_id: "lic_old",
    binding_status: "active",
    license_status: "active",
    expires_at: "2027-01-01T00:00:00.000Z",
    activated_at: "2026-07-01T00:00:00.000Z",
    last_seen_at: "2026-07-06T00:00:00.000Z",
  },
  {
    license_id: "lic_recent",
    binding_status: "active",
    license_status: "active",
    expires_at: "2088-11-11T11:11:00.000Z",
    activated_at: "2026-07-07T00:00:00.000Z",
    last_seen_at: "2026-07-08T10:00:00.000Z",
  },
  {
    license_id: "lic_disabled",
    binding_status: "disabled",
    license_status: "active",
    expires_at: "2099-01-01T00:00:00.000Z",
    activated_at: "2026-07-08T00:00:00.000Z",
    last_seen_at: "2026-07-08T11:00:00.000Z",
  },
  {
    license_id: "lic_expired",
    binding_status: "active",
    license_status: "active",
    expires_at: "2026-07-07T00:00:00.000Z",
    activated_at: "2026-07-08T00:00:00.000Z",
    last_seen_at: "2026-07-08T11:30:00.000Z",
  },
];

assert.equal(
  chooseValidLicenseScope(bindings, "", now),
  "lic_recent",
  "config delivery should fall back to the device's most recent valid license when the client omits licenseId",
);
assert.equal(
  chooseValidLicenseScope(bindings, "lic_old", now),
  "lic_old",
  "an explicit valid license remains authoritative",
);
assert.equal(
  chooseValidLicenseScope(bindings, "lic_disabled", now),
  "lic_recent",
  "a stale/disabled requested license must fall back to the device's other valid license, not deny an activated device",
);
assert.equal(
  chooseValidLicenseScope(bindings, "lic_missing", now),
  "lic_recent",
  "an unknown requested license must fall back to the device's own valid binding (activated → always usable)",
);
assert.equal(
  chooseValidLicenseScope(
    [
      { license_id: "lic_disabled", binding_status: "disabled", license_status: "active", expires_at: "2099-01-01T00:00:00.000Z", activated_at: "2026-07-08T00:00:00.000Z", last_seen_at: "2026-07-08T11:00:00.000Z" },
      { license_id: "lic_expired", binding_status: "active", license_status: "active", expires_at: "2026-07-07T00:00:00.000Z", activated_at: "2026-07-08T00:00:00.000Z", last_seen_at: "2026-07-08T11:30:00.000Z" },
    ],
    "lic_disabled",
    now,
  ),
  "",
  "a device with NO valid binding must still be denied (guarantee applies only to genuinely activated devices)",
);

// Fingerprint-based license recovery: a reinstalled device (new random deviceId,
// same hardware fingerprint) must be able to adopt its own paid license from the
// sibling device that still holds the binding — but only within seat limits and
// only when the fingerprint bucket is unambiguous.
const recoveryNow = Date.parse("2026-07-09T00:00:00.000Z");
const recoveryCandidates = [
  { license_id: "lic_paid", binding_status: "active", license_status: "active", expires_at: "2027-01-01T00:00:00.000Z", last_seen_at: "2026-07-08T00:00:00.000Z", seats: 3, active_bindings: 2 },
];
assert.deepEqual(
  chooseFingerprintRecoveryLicense(recoveryCandidates, { bucketDeviceCount: 1, nowMs: recoveryNow }),
  { licenseId: "lic_paid" },
  "a reinstalled device recovers its license from a same-fingerprint sibling when a seat is free",
);
assert.equal(
  chooseFingerprintRecoveryLicense(
    [{ ...recoveryCandidates[0], active_bindings: 3 }],
    { bucketDeviceCount: 1, nowMs: recoveryNow },
  ),
  null,
  "recovery must respect the seat limit — no free seat means no auto-adopt",
);
assert.equal(
  chooseFingerprintRecoveryLicense(recoveryCandidates, { bucketDeviceCount: 50, nowMs: recoveryNow }),
  null,
  "an ambiguous fingerprint shared by many devices must not auto-adopt a license",
);
assert.equal(
  chooseFingerprintRecoveryLicense(
    [{ ...recoveryCandidates[0], expires_at: "2020-01-01T00:00:00.000Z" }],
    { bucketDeviceCount: 1, nowMs: recoveryNow },
  ),
  null,
  "an expired sibling license is never recovered",
);

// Boot-time fail-closed: production must not run on the packaged dev secret,
// which would leave gateway tokens forgeable.
const { assertProductionSecrets, DEV_SHARED_SECRET } = await import("../server/src/config.js");
assert.doesNotThrow(
  () => assertProductionSecrets({ NODE_ENV: "development" }),
  "dev/local boot must be allowed even on the default secret",
);
if (process.env.SESSION_SECRET && process.env.SESSION_SECRET !== DEV_SHARED_SECRET) {
  assert.doesNotThrow(
    () => assertProductionSecrets({ NODE_ENV: "production" }),
    "production boot with real secrets configured must be allowed",
  );
} else {
  assert.throws(
    () => assertProductionSecrets({ NODE_ENV: "production" }),
    /packaged dev secret/,
    "production boot on the default dev secret must fail closed",
  );
}

console.log("device license scope fallback ok");
