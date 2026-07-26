#!/usr/bin/env node
import assert from "node:assert/strict";
import { assertWindowsPackSmokeHost } from "./lib/windows-runtime-release.mjs";

assert.throws(
  () => assertWindowsPackSmokeHost("darwin"),
  /must run on Windows/i,
  "a non-Windows host must not approve a Windows package without executing its runtime",
);
assert.doesNotThrow(
  () => assertWindowsPackSmokeHost("win32"),
  "a Windows host may execute the packaged runtime smoke probe",
);

console.log("win-pack smoke policy: ok");
