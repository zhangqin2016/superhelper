#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  LARGE_INPUT_PROTOCOL_GUIDANCE,
  appendLargeInputProtocolGuidance,
} = require("../src/main/large-input-protocol.js");

assert(
  LARGE_INPUT_PROTOCOL_GUIDANCE.includes("inspect"),
  "guidance tells agent to inspect first",
);
assert(
  LARGE_INPUT_PROTOCOL_GUIDANCE.includes("do not read or attach the entire input blindly"),
  "guidance forbids blind ingestion",
);
assert(
  LARGE_INPUT_PROTOCOL_GUIDANCE.includes("fall back to normal tools"),
  "guidance requires fail-open fallback",
);
assert(
  LARGE_INPUT_PROTOCOL_GUIDANCE.includes("Do not claim full-file coverage from samples"),
  "guidance prevents sampled evidence from becoming false full coverage",
);

const once = appendLargeInputProtocolGuidance("BASE GUIDE");
const twice = appendLargeInputProtocolGuidance(once);
assert.equal(
  (twice.match(/Large Input Protocol/g) || []).length,
  1,
  "guidance is idempotent",
);
assert(once.startsWith("BASE GUIDE"), "existing guide remains first");
assert.equal(
  appendLargeInputProtocolGuidance(""),
  LARGE_INPUT_PROTOCOL_GUIDANCE,
  "empty guide returns only large-input guidance",
);

console.log("large-input-protocol: ok");
