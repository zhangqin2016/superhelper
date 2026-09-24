#!/usr/bin/env node
// Mobile relay routing core (pure). Security-relevant: it decides who can
// reach whom. Three connection kinds — a desktop's control channel (one
// socket for all its pairings), a legacy per-pairing desktop, and a phone.
import assert from "node:assert/strict";

// mobile-relay.js imports the db module, which requires a URL (never dialled here).
process.env.DATABASE_URL ||= "postgres://test:test@localhost:5432/test";

const { createRelayRegistry, RELAY_FRAME } = await import("../server/src/services/mobile-relay-core.js");

// --- channel: one desktop socket carries several pairings --------------------
{
  const r = createRelayRegistry();
  assert.deepEqual(r.addChannel({ connId: "ch1", deviceId: "dtop", userId: "u1", grantIds: ["g1", "g2"] }), { ok: true, replaced: [] });
  r.addMobile({ connId: "m1", grantId: "g1", deviceId: "phoneA" });
  r.addMobile({ connId: "m2", grantId: "g2", deviceId: "phoneB" });

  // phone → desktop: wrapped, tagged with the pairing it came from
  assert.deepEqual(r.route("m1", { type: "command" }).deliveries, [{ connId: "ch1", grantId: "g1", wrap: true }]);
  assert.deepEqual(r.route("m2", { type: "command" }).deliveries, [{ connId: "ch1", grantId: "g2", wrap: true }]);

  // desktop → phone: an envelope names the pairing; only its phone receives
  const out = r.route("ch1", { type: RELAY_FRAME, grantId: "g2", frame: { type: "assistant.delta", text: "hi" } });
  assert.deepEqual(out.deliveries, [{ connId: "m2", wrap: false }]);
  assert.deepEqual(out.frame, { type: "assistant.delta", text: "hi" }, "the phone gets the inner frame, not the envelope");

  // a channel cannot address a pairing it does not carry
  assert.equal(r.route("ch1", { type: RELAY_FRAME, grantId: "gX", frame: { type: "x" } }).code, "RELAY_GRANT_NOT_BOUND");
  assert.equal(r.route("ch1", { type: "assistant.delta" }).code, "RELAY_FRAME_INVALID", "a channel must use envelopes");
  assert.equal(r.route("ch1", { type: RELAY_FRAME, grantId: "g1", frame: "string" }).code, "RELAY_FRAME_INVALID");

  assert.deepEqual(r.presence("g1"), { desktop: true, mobiles: 1 });
  assert.equal(r.channelFor("dtop"), "ch1");
}

// --- a pairing activated later joins the live channel ----------------------
{
  const r = createRelayRegistry();
  r.addChannel({ connId: "ch1", deviceId: "dtop", userId: "u1", grantIds: [] });
  r.addMobile({ connId: "m1", grantId: "g9", deviceId: "phone" });
  assert.deepEqual(r.route("m1", { type: "command" }).deliveries, [], "before activation the desktop is not reachable");
  assert.equal(r.bindGrant("ch1", "g9"), null);
  assert.deepEqual(r.route("m1", { type: "command" }).deliveries, [{ connId: "ch1", grantId: "g9", wrap: true }]);
  assert.equal(r.bindGrant("m1", "g9"), null, "only a channel can carry pairings");
}

// --- a reconnecting channel replaces the old one; a channel displaces legacy --
{
  const r = createRelayRegistry();
  r.addLegacyDesktop({ connId: "old", grantId: "g1", deviceId: "dtop" });
  r.addChannel({ connId: "ch1", deviceId: "dtop", userId: "u1", grantIds: ["g1"] });
  assert.equal(r.connsForGrant("g1").desktop, "ch1");
  assert.equal(r.connInfo("old"), null, "the displaced legacy connection is forgotten");
  const second = r.addChannel({ connId: "ch2", deviceId: "dtop", userId: "u1", grantIds: ["g1"] });
  assert.deepEqual(second.replaced, ["ch1"], "the stale channel is to be closed");
  assert.equal(r.channelFor("dtop"), "ch2");
  assert.equal(r.connsForGrant("g1").desktopKind, "channel");
  // closing the stale socket later must not disturb the live one
  assert.equal(r.remove("ch1").ok, false);
  assert.equal(r.connsForGrant("g1").desktop, "ch2");
}

// --- legacy desktops keep working exactly as before -------------------------
{
  const r = createRelayRegistry();
  r.addLegacyDesktop({ connId: "d1", grantId: "g1", deviceId: "dtop" });
  r.addMobile({ connId: "m1", grantId: "g1", deviceId: "dmob" });
  r.addMobile({ connId: "m2", grantId: "g1", deviceId: "dmob" });
  assert.deepEqual(r.route("m1", { type: "command" }).deliveries, [{ connId: "d1", grantId: "g1", wrap: false }], "raw to a legacy desktop");
  assert.deepEqual(r.route("d1", { type: "assistant.delta" }).deliveries.map((d) => d.connId).sort(), ["m1", "m2"], "fan-out to the grant's phones");
  const again = r.addLegacyDesktop({ connId: "d2", grantId: "g1", deviceId: "dtop" });
  assert.deepEqual(again.replaced, ["d1"], "a reconnecting legacy desktop replaces the stale one");
}

// --- ending a pairing returns exactly what to close / notify -----------------
{
  const r = createRelayRegistry();
  r.addChannel({ connId: "ch1", deviceId: "dtop", userId: "u1", grantIds: ["g1", "g2"] });
  r.addMobile({ connId: "m1", grantId: "g1", deviceId: "phoneA" });
  r.addMobile({ connId: "m2", grantId: "g2", deviceId: "phoneB" });
  assert.deepEqual(r.endGrant("g1"), { mobiles: ["m1"], legacyDesktop: null, channel: "ch1" });
  assert.equal(r.route("ch1", { type: RELAY_FRAME, grantId: "g1", frame: { type: "x" } }).code, "RELAY_GRANT_NOT_BOUND", "an ended pairing is unreachable at once");
  assert.deepEqual(r.route("m2", { type: "command" }).deliveries.length, 1, "other pairings are untouched");
  assert.deepEqual(r.endGrant("nope"), { mobiles: [], legacyDesktop: null, channel: null });

  r.addLegacyDesktop({ connId: "d9", grantId: "g9", deviceId: "dtop" });
  assert.deepEqual(r.endGrant("g9"), { mobiles: [], legacyDesktop: "d9", channel: null });
}

// --- presence changes are reported on remove --------------------------------
{
  const r = createRelayRegistry();
  r.addChannel({ connId: "ch1", deviceId: "dtop", userId: "u1", grantIds: ["g1", "g2"] });
  r.addMobile({ connId: "m1", grantId: "g1", deviceId: "phone" });
  assert.deepEqual(r.remove("ch1").grantIds.sort(), ["g1", "g2"], "a dropped channel changes presence of all its pairings");
  assert.deepEqual(r.presence("g1"), { desktop: false, mobiles: 1 });
  assert.deepEqual(r.route("m1", { type: "command" }).deliveries, [], "phone sees the desktop offline");
  assert.deepEqual(r.remove("m1").grantIds, ["g1"]);
  assert.equal(r.stats().grants, 0, "empty pairings are garbage-collected");
}

// --- validation --------------------------------------------------------------
{
  const r = createRelayRegistry();
  assert.equal(r.addMobile({ connId: "", grantId: "g1", deviceId: "d" }).code, "RELAY_CONN_INVALID");
  assert.equal(r.addChannel({ connId: "c", deviceId: "d", userId: "" }).code, "RELAY_CONN_INVALID");
  r.addMobile({ connId: "m1", grantId: "g1", deviceId: "d" });
  assert.equal(r.addMobile({ connId: "m1", grantId: "g1", deviceId: "d" }).code, "RELAY_CONN_DUPLICATE");
  assert.equal(r.route("ghost", {}).code, "RELAY_CONN_UNKNOWN");
}

// --- presence frames, per connection kind ------------------------------------
{
  const { presenceFrameFor } = await import("../server/src/services/mobile-relay.js");
  assert.deepEqual(presenceFrameFor("mobile", { desktop: true, mobiles: 2 }), { type: "relay.presence", desktopOnline: true });
  assert.deepEqual(presenceFrameFor("channel", { desktop: true, mobiles: 2 }, "g1"), { type: "control.presence", grantId: "g1", mobilesOnline: 2 });
  assert.deepEqual(presenceFrameFor("legacy", { desktop: true, mobiles: 2 }), { type: "relay.presence", mobilesOnline: 2 });
}

// --- the phone's device label -------------------------------------------------
{
  const { mobileLabelFromUserAgent } = await import("../server/src/services/mobile-device-label.js");
  assert.equal(mobileLabelFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"), "iPhone · Safari");
  assert.equal(mobileLabelFromUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36"), "Android · Chrome");
  assert.equal(mobileLabelFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49"), "iPhone · 微信");
  assert.equal(mobileLabelFromUserAgent("Mozilla/5.0 (Linux; Android 12; HarmonyOS; NOH-AN00) AppleWebKit/537.36 Chrome/99.0 Mobile Safari/537.36"), "鸿蒙 · Chrome");
  assert.equal(mobileLabelFromUserAgent(""), null);
  assert.equal(mobileLabelFromUserAgent("curl/8.4"), null, "no guess for an unknown agent");
}

console.log("mobile-relay-core: ok");
