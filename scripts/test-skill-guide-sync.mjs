#!/usr/bin/env node
// Regression: platform guide edits (guideMd_i18n) must reach already-installed
// skill copies on the next launch WITHOUT a version bump. The old sync only
// filled when missing, so every guide edit silently stayed in the repo — the
// running app kept serving stale rules ("works on my repo, never in the app").
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ud = fs.mkdtempSync(path.join(os.tmpdir(), "lily-guidesync-"));
process.env.LILY_USER_DATA_DIR = ud;
process.env.LILY_HOME = ud;

const skillManager = require("../src/main/skill-manager.js");

const SKILL = "lily-workbench-rules";
const installedPath = path.join(ud, "lily-config", "skills", SKILL, "skill.manifest.json");
const speechScriptPath = path.join(ud, "lily-config", "skills", "lily-speech-generation", "scripts", "generate-speech.cjs");

// First launch: install bundled skills into the temp userData.
skillManager.ensureBundledPresent();
assert.ok(fs.existsSync(installedPath), "skill installed on first launch");

const bundled = require(path.resolve("resources/skills", SKILL, "skill.manifest.json"));
const bundledBody = bundled.guideMd_i18n["zh-CN"].body;

// Simulate a stale installed copy (older guide text), same version — exactly the
// situation a guide edit creates: bundled changed, installed didn't, version equal.
const installed = JSON.parse(fs.readFileSync(installedPath, "utf8"));
installed.guideMd_i18n["zh-CN"].body = "STALE OLD GUIDE TEXT";
fs.writeFileSync(installedPath, JSON.stringify(installed, null, 2));
assert.equal(installed.version, bundled.version, "version unchanged (no bump) — the case that used to fail");

// Next launch: sync must update the installed guide to match bundled.
skillManager.ensureBundledPresent();
const after = JSON.parse(fs.readFileSync(installedPath, "utf8")).guideMd_i18n["zh-CN"].body;
assert.equal(after, bundledBody, "guide edit propagated to the installed copy without a version bump");
assert.notEqual(after, "STALE OLD GUIDE TEXT", "stale guide replaced");

// Bundled platform skill scripts are also app-owned. A same-version script fix
// must reach the installed userData copy; otherwise the running app keeps using
// stale media/client logic even though the repo and release contain the fix.
assert.ok(fs.existsSync(speechScriptPath), "speech generation script installed on first launch");
fs.writeFileSync(speechScriptPath, "#!/usr/bin/env node\nconsole.error('STALE OLD SCRIPT');\n", "utf8");
skillManager.ensureBundledPresent();
const restoredScript = fs.readFileSync(speechScriptPath, "utf8");
const bundledScript = fs.readFileSync(path.resolve("resources/skills/lily-speech-generation/scripts/generate-speech.cjs"), "utf8");
assert.equal(restoredScript, bundledScript, "bundled skill script edit propagated to installed copy without a version bump");
assert.ok(!restoredScript.includes("STALE OLD SCRIPT"), "stale installed script replaced");

fs.rmSync(ud, { recursive: true, force: true });
console.log("skill-guide-sync: ok");
