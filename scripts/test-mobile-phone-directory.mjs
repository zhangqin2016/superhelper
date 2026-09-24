#!/usr/bin/env node
// The desktop's view of its phones: hello replaces, events update, presence
// is dropped when the channel is down, lapsed requests disappear.
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { createPhoneDirectory } = require(path.join(ROOT, "src/main/mobile/phone-directory.js"));

let now = Date.parse("2026-09-24T10:00:00Z");
const dir = createPhoneDirectory({ now: () => now });
let changes = 0;
dir.subscribe(() => { changes += 1; });

const phoneA = { grantId: "gA", mobileDeviceId: "mweb_a", mobileLabel: "iPhone · Safari", status: "active" };
const phoneB = { grantId: "gB", mobileDeviceId: "mweb_b", mobileLabel: null, status: "active" };
const request = { grantId: "gP", mobileDeviceId: "mweb_p", approvalExpiresAt: "2026-09-24T10:05:00Z" };

dir.apply({ type: "status", status: "online" });
dir.apply({ type: "hello", grants: [phoneA, phoneB], pending: [request] });
assert.deepEqual(dir.snapshot().phones.map((p) => [p.grantId, p.online]), [["gA", false], ["gB", false]]);
assert.deepEqual(dir.snapshot().pending.map((p) => p.grantId), ["gP"]);
assert.deepEqual(dir.grantIds(), ["gA", "gB"]);

// presence
assert.equal(dir.apply({ type: "presence", grantId: "gA", mobilesOnline: 1 }), true);
assert.equal(dir.apply({ type: "presence", grantId: "gA", mobilesOnline: 1 }), false, "no change, no notification");
assert.equal(dir.apply({ type: "presence", grantId: "ghost", mobilesOnline: 1 }), false, "presence of an unknown pairing is ignored");
assert.equal(dir.snapshot().phones.find((p) => p.grantId === "gA").online, true);

// a request is approved → it moves from pending to phones
dir.apply({ type: "active", grant: { ...request, status: "active" } });
assert.deepEqual(dir.snapshot().pending, []);
assert.ok(dir.has("gP"));

// ended
dir.apply({ type: "ended", grantId: "gB", reason: "user_action" });
assert.ok(!dir.has("gB"));
assert.equal(dir.apply({ type: "ended", grantId: "gB" }), false, "ending twice is a no-op");

// channel down → nobody is known to be on the line
dir.apply({ type: "status", status: "offline" });
assert.ok(dir.snapshot().phones.every((p) => !p.online));
assert.equal(dir.snapshot().channel, "offline");

// a reconnect's hello is the whole truth (reconnect = reconcile)
dir.apply({ type: "hello", grants: [phoneA], pending: [] });
assert.deepEqual(dir.grantIds(), ["gA"], "pairings ended while offline are gone after hello");

// a lapsed request disappears without any event
dir.apply({ type: "pending", grant: { grantId: "gQ", approvalExpiresAt: "2026-09-24T10:01:00Z" } });
assert.equal(dir.nextExpiry(), Date.parse("2026-09-24T10:01:00Z"));
now = Date.parse("2026-09-24T10:02:00Z");
assert.deepEqual(dir.snapshot().pending, []);
assert.equal(dir.nextExpiry(), null);

assert.ok(changes >= 8);
console.log("mobile-phone-directory: ok");
