#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  OPENCODE_RUNTIME_CAPABILITIES,
  capabilitiesForRuntime,
  normalizeRuntimeCapabilities,
} = require("../src/main/runtime/runtime-capabilities.js");

assert.equal(OPENCODE_RUNTIME_CAPABILITIES.resume, true);
assert.equal(OPENCODE_RUNTIME_CAPABILITIES.nativeCompaction, true);
assert.equal(OPENCODE_RUNTIME_CAPABILITIES.manualSummarize, true);
assert.equal(OPENCODE_RUNTIME_CAPABILITIES.backgroundCompaction, true);

assert.deepEqual(
  normalizeRuntimeCapabilities({
    resume: 1,
    nativeCompaction: "yes",
    manualSummarize: "",
    unknown: true,
  }),
  {
    streamInput: false,
    emitsThinking: false,
    hotEnvUpdate: false,
    permissionControl: false,
    permissionAlwaysAsk: false,
    resume: true,
    nativeCompaction: true,
    manualSummarize: false,
    backgroundCompaction: false,
    rawHistory: false,
    plugins: false,
    hooks: false,
  },
  "normalization keeps a stable capability shape and drops unknown keys",
);

assert.equal(capabilitiesForRuntime("opencode").nativeCompaction, true);
assert.equal(capabilitiesForRuntime("unknown").nativeCompaction, false);

console.log("runtime-capabilities: ok");
