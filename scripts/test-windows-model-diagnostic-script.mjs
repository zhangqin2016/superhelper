#!/usr/bin/env node
//
// Static guard for the Windows customer diagnostic script. The script is run on
// customer machines, so we keep this test focused on the repair contract rather
// than executing PowerShell on non-Windows CI.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./lib/test-assert.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ps1 = fs.readFileSync(path.join(ROOT, "scripts/windows-model-connection-diagnose.ps1"), "utf8");
const cmd = fs.readFileSync(path.join(ROOT, "scripts/windows-model-connection-diagnose.cmd"), "utf8");

assert(ps1.includes("Repair-ModelSettingsJson"), "diagnostic script should repair corrupt model-settings JSON");
assert(ps1.includes("ConvertFrom-Json"), "repair should validate JSON with PowerShell's JSON parser");
assert(ps1.includes(".corrupt-$Stamp.bak"), "repair should preserve corrupt model-settings as a timestamped backup");
assert(ps1.includes('"activePresetId": null'), "repair should write a minimal default model-settings file");
assert(ps1.includes('"mode": "builtin"'), "repair should restore the builtin model gateway mode");
assert(!/Remove-Item\s+.*model-settings\.json/i.test(ps1), "repair must not delete model-settings.json");
assert(cmd.includes("-Repair -NoPause"), "double-click launcher should keep safe repair mode enabled");

console.log("windows-model-diagnostic-script: ok");
