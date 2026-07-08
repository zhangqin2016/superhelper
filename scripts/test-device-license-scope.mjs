#!/usr/bin/env node
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/lily_test";

const { chooseValidLicenseScope } = await import("../server/src/services/device-identity.js");

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
  "",
  "disabled explicit bindings must not authorize gateway tokens",
);
assert.equal(
  chooseValidLicenseScope(bindings, "lic_missing", now),
  "",
  "a requested license not bound to the device must not fall back to another license",
);

console.log("device license scope fallback ok");
