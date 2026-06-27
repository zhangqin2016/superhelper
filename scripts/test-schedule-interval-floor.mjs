#!/usr/bin/env node
/**
 * Interval schedule normalization: sub-minute ("every 5 seconds") intervals must
 * fold up to a whole-minute floor (the scheduler ticks every 60s, so anything
 * faster is impossible AND abusive), and plural units must be accepted. WHY it
 * matters: a valid-but-too-fast request like "每5秒写小说" previously failed
 * normalization, which dropped the user into ad-hoc script improvisation instead
 * of creating a (floored) scheduled task.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeScheduleSpec } = require("../src/main/schedule-parser.js");

// seconds -> clamped to a >=1-minute interval
assert.deepEqual(normalizeScheduleSpec({ type: "interval", every: 5, unit: "second" }), { type: "interval", every: 1, unit: "minute" }, "every 5s -> 1 min floor");
assert.deepEqual(normalizeScheduleSpec({ type: "interval", every: 90, unit: "seconds" }), { type: "interval", every: 2, unit: "minute" }, "every 90s -> 2 min");
assert.deepEqual(normalizeScheduleSpec({ type: "interval", every: 30, unit: "second" }), { type: "interval", every: 1, unit: "minute" }, "every 30s -> 1 min (rounds to floor)");

// plural units accepted (model often emits plurals)
assert.deepEqual(normalizeScheduleSpec({ type: "interval", every: 5, unit: "minutes" }), { type: "interval", every: 5, unit: "minute" }, "plural 'minutes' accepted");
assert.deepEqual(normalizeScheduleSpec({ type: "interval", every: 2, unit: "hours" }), { type: "interval", every: 2, unit: "hour" }, "plural 'hours' accepted");

// genuine minute/hour/day intervals unchanged
assert.deepEqual(normalizeScheduleSpec({ type: "interval", every: 5, unit: "minute" }), { type: "interval", every: 5, unit: "minute" }, "minute interval unchanged");

// nonsense unit still rejected
assert.equal(normalizeScheduleSpec({ type: "interval", every: 5, unit: "fortnight" }), null, "unknown unit rejected");

console.log("schedule-interval-floor: ok");
