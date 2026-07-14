#!/usr/bin/env node
// Mobile Command relay routing core. Correctness-critical: a wrong target means
// one user's command reaches another user's desktop. Pure, no sockets.

import assert from "node:assert/strict";

const { createRelayRegistry } = await import("../server/src/services/mobile-relay-core.js");

// --- register + route within one grant --------------------------------------
{
  const r = createRelayRegistry();
  assert.equal(r.add({ connId: "d1", role: "desktop", grantId: "g1", deviceId: "dtop" }).ok, true);
  assert.equal(r.add({ connId: "m1", role: "mobile", grantId: "g1", deviceId: "dmob" }).ok, true);

  // mobile command → the grant's desktop
  assert.deepEqual(r.targetsFor("m1"), { ok: true, targets: ["d1"] });
  // desktop projection → the grant's mobile(s)
  assert.deepEqual(r.targetsFor("d1"), { ok: true, targets: ["m1"] });
  assert.deepEqual(r.stats(), { grants: 1, connections: 2 });
}

// --- isolation: messages never cross grants ---------------------------------
{
  const r = createRelayRegistry();
  r.add({ connId: "d1", role: "desktop", grantId: "g1", deviceId: "dtopA" });
  r.add({ connId: "m1", role: "mobile", grantId: "g1", deviceId: "dmobA" });
  r.add({ connId: "d2", role: "desktop", grantId: "g2", deviceId: "dtopB" });
  r.add({ connId: "m2", role: "mobile", grantId: "g2", deviceId: "dmobB" });
  assert.deepEqual(r.targetsFor("m1").targets, ["d1"], "grant g1 mobile only reaches g1 desktop");
  assert.deepEqual(r.targetsFor("m2").targets, ["d2"], "grant g2 mobile only reaches g2 desktop");
  assert.deepEqual(r.targetsFor("d1").targets, ["m1"], "grant g1 desktop only reaches g1 mobile");
}

// --- desktop reconnect replaces the stale desktop connection ----------------
{
  const r = createRelayRegistry();
  r.add({ connId: "d1", role: "desktop", grantId: "g1", deviceId: "dtop" });
  r.add({ connId: "m1", role: "mobile", grantId: "g1", deviceId: "dmob" });
  const re = r.add({ connId: "d1b", role: "desktop", grantId: "g1", deviceId: "dtop" });
  assert.equal(re.ok, true);
  assert.equal(re.replaced, "d1", "a reconnecting desktop replaces its stale connection");
  assert.equal(r.connInfo("d1"), null, "the stale desktop conn is dropped");
  assert.deepEqual(r.targetsFor("m1").targets, ["d1b"], "mobile now routes to the fresh desktop");
}

// --- multiple mobiles on one grant: desktop projection fans out -------------
{
  const r = createRelayRegistry();
  r.add({ connId: "d1", role: "desktop", grantId: "g1", deviceId: "dtop" });
  r.add({ connId: "m1", role: "mobile", grantId: "g1", deviceId: "dmob" });
  r.add({ connId: "m2", role: "mobile", grantId: "g1", deviceId: "dmob" });
  assert.deepEqual(r.targetsFor("d1").targets.sort(), ["m1", "m2"], "projection reaches all mobiles of the grant");
}

// --- peer offline: no targets, not an error ---------------------------------
{
  const r = createRelayRegistry();
  r.add({ connId: "m1", role: "mobile", grantId: "g1", deviceId: "dmob" });
  assert.deepEqual(r.targetsFor("m1"), { ok: true, targets: [] }, "a command with no desktop online has no target");
}

// --- disconnect cleanup ------------------------------------------------------
{
  const r = createRelayRegistry();
  r.add({ connId: "d1", role: "desktop", grantId: "g1", deviceId: "dtop" });
  r.add({ connId: "m1", role: "mobile", grantId: "g1", deviceId: "dmob" });
  r.remove("m1");
  assert.deepEqual(r.targetsFor("d1").targets, [], "desktop has no mobile after it disconnects");
  r.remove("d1");
  assert.deepEqual(r.stats(), { grants: 0, connections: 0 }, "an empty grant is garbage-collected");
  assert.equal(r.targetsFor("d1").ok, false, "an unknown connection is reported");
}

// --- validation --------------------------------------------------------------
{
  const r = createRelayRegistry();
  assert.equal(r.add({ connId: "", role: "desktop", grantId: "g1", deviceId: "d" }).code, "RELAY_CONN_INVALID");
  assert.equal(r.add({ connId: "x", role: "peer", grantId: "g1", deviceId: "d" }).code, "RELAY_ROLE_INVALID");
  r.add({ connId: "d1", role: "desktop", grantId: "g1", deviceId: "d" });
  assert.equal(r.add({ connId: "d1", role: "mobile", grantId: "g1", deviceId: "d" }).code, "RELAY_CONN_DUPLICATE");
}

console.log("mobile-relay-core: ok");
