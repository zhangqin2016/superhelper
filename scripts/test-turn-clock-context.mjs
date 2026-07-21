#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { currentDateTimeLine } = require("../src/main/turn-clock-context.js");

// Format: unambiguous ISO date, local time, numeric UTC offset, and guidance
// that hands the freshness JUDGMENT to the model.
{
  const line = currentDateTimeLine(new Date(2026, 6, 20, 9, 5)); // local 2026-07-20 09:05
  assert.match(line, /^Current date\/time: 2026-07-20 09:05 \(UTC[+-]\d/);
  assert.match(line, /check live sources instead of relying on training memory/);
  assert.match(line, /来源/, "citation guidance names the expected section");
  assert.match(line, /exact URLs copied from the tool results/, "citation guidance demands URLs, not source names");
}

// Offset rendering: whole-hour, half-hour, and behind-UTC zones all render
// correctly. Fake `now` objects keep this independent of the runner's zone.
{
  const fake = (offsetMinutes) => ({
    getTimezoneOffset: () => -offsetMinutes,
    getFullYear: () => 2026, getMonth: () => 6, getDate: () => 20,
    getHours: () => 9, getMinutes: () => 5,
  });
  assert(currentDateTimeLine(fake(8 * 60)).includes("(UTC+8)"));
  assert(currentDateTimeLine(fake(5 * 60 + 30)).includes("(UTC+5:30)"));
  assert(currentDateTimeLine(fake(-7 * 60)).includes("(UTC-7)"));
}

// Every turn injects the clock exactly once via the platform_context layer —
// the orchestrator line count is ratcheted, so the initialization itself
// carries the injection.
{
  const orchestrator = fs.readFileSync("src/main/turn-orchestrator.js", "utf8");
  const injections = orchestrator.match(/turn-clock-context/g) || [];
  assert.equal(injections.length, 1, "one clock injection site in the orchestrator");
  assert.match(orchestrator, /platformContextParts = \[require\("\.\/turn-clock-context"\)\.currentDateTimeLine\(\)\]/);
}

console.log("turn-clock-context: ok");
