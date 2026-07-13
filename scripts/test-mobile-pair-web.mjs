#!/usr/bin/env node
// Static guard for the mobile pairing web page (desktop-vouched, no login).
// Locks the pairing/relay flow structure + the exact endpoints it calls so they
// can't drift from the server. On-device round-trip is validated server-side by
// server/scripts/mobile-command-e2e.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = fs.readFileSync(path.join(ROOT, "web/app/m/pair/page.js"), "utf8");

assert.match(page, /^"use client";/, "the pairing page is a client component");

// NO login: the phone must not call any auth/SMS endpoints or hold a bearer.
assert.doesNotMatch(page, /\/api\/auth\/sms\//, "the phone does not send/verify SMS codes");
assert.doesNotMatch(page, /accessToken/, "the phone holds no account access token");
assert.doesNotMatch(page, /Authorization/, "the phone sends no bearer");

// Pairing: consume with just a device id + one-time token, get a grant token.
assert.match(page, /\/api\/mobile\/pairing\/consume/, "consumes the pairing challenge");
assert.match(page, /deviceId/, "sends the browser device id");
assert.match(page, /mobileToken/, "uses the grant-scoped token returned by consume");

// Transport: relay as the mobile role, carrying the grant token (not a bearer).
assert.match(page, /role=mobile/, "connects the relay as the mobile role");
assert.match(page, /\/api\/mobile\/relay/, "connects the relay endpoint");
assert.match(page, /grantId=/, "relay connection carries the grant id");
assert.match(page, /token=\$\{encodeURIComponent\(mobileToken\)\}/, "relay is authenticated with the grant token");

// Command envelope shape the desktop bridge expects.
assert.match(page, /type: "command"/, "sends a command envelope");
assert.match(page, /commandId/, "the command carries a commandId (idempotency)");
assert.match(page, /command\.admitted/, "renders the admission ack");
assert.match(page, /command\.rejected/, "renders a rejection");

// Projected desktop turn output — the phone sees the reply it triggered.
assert.match(page, /"assistant\.delta"/, "accumulates streaming assistant text");
assert.match(page, /"turn\.started"/, "resets the reply on a new turn");
assert.match(page, /"turn\.ended"/, "marks the turn done/failed/interrupted");
assert.match(page, /桌面回复/, "renders a reply panel");

// Retry-until-approved: the relay refuses until the desktop approves.
assert.match(page, /setTimeout\(tryOnce/, "retries the relay connection until approval flips the grant active");

// Scan deep link: a QR opens /m/pair#u=<api>&t=<token>; scanning auto-pairs.
assert.match(page, /parseScanHash/, "parses the scanned QR deep link");
assert.match(page, /\bt=/, "reads the token param from the scan hash");
assert.match(page, /pageOrigin\(\)/, "falls back to the page origin as the API base when scanned");
assert.match(page, /autoPairedRef/, "auto-pairs once when opened via a scanned deep link");

// One-time token: never consume twice (StrictMode double-invoke / double tap).
assert.match(page, /consumingRef/, "guards against a double consume of the one-time token");
assert.match(page, /if \(consumingRef\.current\) return/, "pair() returns early if a consume is already in flight/done");
assert.match(page, /PAIRING_CHALLENGE_INVALID_OR_EXPIRED/, "shows a clear message when the code expired/was used");

console.log("mobile-pair-web: ok");
