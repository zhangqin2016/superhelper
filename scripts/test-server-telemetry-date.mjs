#!/usr/bin/env node
import assert from "node:assert/strict";
import { usageDateKey } from "../server/src/services/usage-date.js";

assert.equal(usageDateKey("2026-06-08"), "2026-06-08");
assert.equal(usageDateKey("2026-06-08T00:00:00.000Z"), "2026-06-08");
assert.equal(usageDateKey("Mon Jun 08 2026 00:00:00 GMT+0400"), "2026-06-08");
assert.equal(usageDateKey(new Date("2026-06-08T12:00:00")), "2026-06-08");

console.log("server-telemetry-date: ok");
