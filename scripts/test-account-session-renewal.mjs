#!/usr/bin/env node
import assert from "node:assert/strict";
import { extendSessionExpiresAt } from "../server/src/services/account-auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const nowMs = Date.parse("2026-07-04T00:00:00.000Z");

assert.equal(
  extendSessionExpiresAt("2026-07-10T00:00:00.000Z", { nowMs }).toISOString(),
  "2026-08-03T00:00:00.000Z",
  "active refresh should renew a near-expiring session by 30 days",
);

assert.equal(
  extendSessionExpiresAt("2026-09-15T00:00:00.000Z", { nowMs }).toISOString(),
  "2026-09-15T00:00:00.000Z",
  "refresh must not shorten an already longer-lived session",
);

assert.equal(
  extendSessionExpiresAt("", { nowMs, ttlMs: 7 * DAY_MS }).toISOString(),
  "2026-07-11T00:00:00.000Z",
  "missing current expiry falls back to the renewal window",
);

console.log("account session renewal ok");
