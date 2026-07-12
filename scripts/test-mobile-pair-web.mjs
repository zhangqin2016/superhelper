#!/usr/bin/env node
// Static guard for the mobile pairing web page. Locks the auth/pairing/relay
// flow structure and the exact endpoints it calls so they can't drift from the
// server. On-device round-trip is validated separately (live-pending).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = fs.readFileSync(path.join(ROOT, "web/app/m/pair/page.js"), "utf8");

assert.match(page, /^"use client";/, "the pairing page is a client component");
// The device-flow auth the account-only consume/relay expects.
assert.match(page, /\/api\/devices\/register/, "registers a browser device");
assert.match(page, /\/api\/auth\/sms\/send/, "sends the SMS code");
assert.match(page, /\/api\/auth\/sms\/login/, "logs in for a bearer access token");
assert.match(page, /accessToken/, "keeps the bearer access token");
// Pairing + transport.
assert.match(page, /\/api\/mobile\/pairing\/consume/, "consumes the pairing challenge");
assert.match(page, /role=mobile/, "connects the relay as the mobile role");
assert.match(page, /\/api\/mobile\/relay/, "connects the relay endpoint");
assert.match(page, /grantId=/, "relay connection carries the grant id");
assert.match(page, /Authorization.*Bearer/s, "consume is called with the bearer token");
// Command envelope shape the desktop bridge expects.
assert.match(page, /type: "command"/, "sends a command envelope");
assert.match(page, /commandId/, "the command carries a commandId (idempotency)");
assert.match(page, /command\.admitted/, "renders the admission ack");
assert.match(page, /command\.rejected/, "renders a rejection");
// Retry-until-approved: the relay refuses until the desktop approves.
assert.match(page, /setTimeout\(tryOnce/, "retries the relay connection until approval flips the grant active");

console.log("mobile-pair-web: ok");
