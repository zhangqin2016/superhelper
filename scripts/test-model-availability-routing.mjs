#!/usr/bin/env node
// model-availability as AUTO-mode routing input: failure marks with escalating
// backoff, same-event dedupe, success clears, and turn-outcome recording.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const a = require("../src/main/model-availability.js");
const claude = { providerID: "p-claude", modelID: "claude-opus-5-5" };

a.resetModelAvailabilityForTests();
const t0 = 1_000_000;

assert.equal(a.isModelAttributableFailure("RATE_LIMITED"), true);
assert.equal(a.isModelAttributableFailure("MODEL_NO_RESPONSE"), true);
assert.equal(a.isModelAttributableFailure("INTERRUPTED"), false);

// 1st failure → 90s; repeated failures escalate so a dead model is not re-picked every 90s
let m = a.noteModelFailure(claude, { code: "RATE_LIMITED", now: t0 });
assert.equal(m.count, 1); assert.equal(m.until, t0 + 90_000); assert.equal(m.reason, "failed");
m = a.noteModelFailure(claude, { code: "RATE_LIMITED", now: t0 + 100_000 });
assert.equal(m.count, 2); assert.equal(m.until, t0 + 100_000 + 5 * 60_000, "2nd failure backs off to 5 min");
m = a.noteModelFailure(claude, { code: "RATE_LIMITED", now: t0 + 200_000 });
assert.equal(m.until, t0 + 200_000 + 15 * 60_000, "3rd failure backs off to 15 min");

// the first-response watchdog and the turn outcome for the SAME event count once
a.resetModelAvailabilityForTests();
a.noteModelUnresponsive(claude, { silentMs: 90_000, now: t0 });
m = a.noteModelFailure(claude, { code: "MODEL_NO_RESPONSE", now: t0 + 20 });
assert.equal(m.count, 1, "same event is not double counted");
assert.equal(m.reason, "no_response");

// annotation carries the mark to routing options
const [opt] = a.annotateModelOptions([{ id: "custom-claude", ...claude }], t0 + 30);
assert.ok(opt.unavailable, "option is annotated unavailable");

// turn outcome: attributable failure marks, clean success clears, others ignored
a.resetModelAvailabilityForTests();
const route = { selectionId: "custom-claude", modelId: claude.modelID, providerId: claude.providerID };
a.noteTurnModelHealth(route, { failed: true, code: "INTERRUPTED" });
assert.equal(a.getModelAvailability(claude), null, "a non-model failure never marks the model");
a.noteTurnModelHealth(route, { failed: true, code: "ENGINE_RESULT_FAILED" });
assert.ok(a.getModelAvailability(claude), "a model-attributable failure marks it");
a.noteTurnModelHealth(route, { failed: false, stalled: true });
assert.ok(a.getModelAvailability(claude), "a stall does not clear the mark");
a.noteTurnModelHealth(route, { failed: false, stalled: false });
assert.equal(a.getModelAvailability(claude), null, "a clean success clears it");

console.log("model-availability-routing: ok");
