#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ensureCharacterAuthoringAvailable } = require("../src/main/character-worlds/authoring-availability.js");

let enabled = false;
let refreshes = 0;
const repaired = await ensureCharacterAuthoringAvailable({
  resolvePolicy: () => ({ enabled }),
  refresh: async (options) => {
    refreshes += 1;
    assert.equal(options.force, true);
    assert.equal(options.repairManagedService, true);
    enabled = true;
    return { ok: true };
  },
});
assert.equal(repaired.ok, true);
assert.equal(repaired.refreshed, true);
assert.equal(refreshes, 1);

const alreadyReady = await ensureCharacterAuthoringAvailable({
  resolvePolicy: () => ({ enabled: true }),
  refresh: async () => { throw new Error("must not refresh an already-ready policy"); },
});
assert.deepEqual(alreadyReady, { ok: true, refreshed: false });

const unavailable = await ensureCharacterAuthoringAvailable({
  resolvePolicy: () => ({ enabled: false, reason: "remote_disabled" }),
  refresh: async () => ({ ok: true }),
});
assert.equal(unavailable.ok, false);
assert.equal(unavailable.error, "CHARACTER_WORLDS_UNAVAILABLE");
assert.equal(unavailable.reason, "remote_disabled");

const refreshFailure = await ensureCharacterAuthoringAvailable({
  resolvePolicy: () => ({ enabled: false }),
  refresh: async () => ({ ok: false, error: "TIMEOUT" }),
});
assert.equal(refreshFailure.ok, false);
assert.equal(refreshFailure.refreshError, "TIMEOUT");

console.log("character-authoring-availability: ok");
