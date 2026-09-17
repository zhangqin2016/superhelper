#!/usr/bin/env node
/**
 * A contract may only name a helper the agent can actually reach, and that
 * helper must really provide what the contract says it provides.
 *
 * Acceptance 2026-09-17 D-S06-01: the PDF contract told the agent to call
 * register_cjk_font() from "resources/runtime-scripts/lily_office_style.py". That
 * path does not resolve from a workspace, so the agent had to guess where the
 * file was — it found a STALE INSTALLED COPY from an older build, correctly
 * reported the function missing, and filed it as a platform defect. The contract
 * and the module it names were from different builds, with nothing tying them
 * together.
 *
 * The host now exports LILY_RUNTIME_SCRIPTS, and this test is the tie: every
 * helper a contract names must exist there, and every symbol it names must be
 * defined in one of those helpers.
 * [gate: runtime-helper-path]
 * Run: node scripts/test-runtime-helper-path.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { SKILL_PLATFORM_OVERLAYS } = require("../src/main/skill-platform-overlays.js");
const { getRuntimeEnvExtras, resolveRuntimeScriptsDir } = require("../src/main/runtime-python.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

// Contract surfaces: everything that can tell an agent to call a shared helper.
const CONTRACT_FILES = [
  "resources/skills-catalog/lily-office-intent/SKILL.md",
  "resources/skills-catalog/lily-pdf-form/SKILL.md",
];
const contractText = [
  ...Object.values(SKILL_PLATFORM_OVERLAYS).flatMap((overlay) => [overlay.en, overlay.zh]),
  ...CONTRACT_FILES.map((file) => fs.readFileSync(path.join(ROOT, file), "utf8")),
].join("\n");

check("the agent is TOLD where the helpers are, absolutely", () => {
  const dir = resolveRuntimeScriptsDir();
  assert.ok(dir, "the running build's runtime-scripts directory must be resolvable");
  assert.ok(path.isAbsolute(dir));
  assert.equal(getRuntimeEnvExtras().LILY_RUNTIME_SCRIPTS, dir, "and it must reach the agent's environment");
});

check("no contract hands out a path the agent cannot resolve from its workspace", () => {
  const relative = contractText.match(/(?<!\$LILY_RUNTIME_SCRIPTS\/)(?<![\w/$])resources\/runtime-scripts\//g) || [];
  assert.deepEqual(relative, [], "a repo-relative helper path is a guess the agent has to make");
});

check("every helper a contract names exists in the running build", () => {
  const dir = resolveRuntimeScriptsDir();
  const named = [...new Set([...contractText.matchAll(/\$LILY_RUNTIME_SCRIPTS\/([A-Za-z0-9_.]+\.py)/g)].map((m) => m[1]))];
  assert.ok(named.length >= 2, `contracts should name the shared helpers, found ${named.length}`);
  for (const file of named) {
    assert.ok(fs.existsSync(path.join(dir, file)), `${file} is named by a contract but is not in ${dir}`);
  }
});

check("every function a contract names is actually defined in one of those helpers", () => {
  const dir = resolveRuntimeScriptsDir();
  const named = [...new Set([...contractText.matchAll(/\$LILY_RUNTIME_SCRIPTS\/([A-Za-z0-9_.]+\.py)/g)].map((m) => m[1]))];
  const source = named.map((file) => fs.readFileSync(path.join(dir, file), "utf8")).join("\n");
  // Only treat a name as a promise when a contract writes it as a call.
  const promised = [...new Set([...contractText.matchAll(/\b([a-z][a-z0-9_]{3,})\(\)/g)].map((m) => m[1]))]
    .filter((symbol) => symbol !== "exists");
  assert.ok(promised.includes("register_cjk_font"), "the field case must be covered");
  const missing = promised.filter((symbol) => !source.includes(`def ${symbol}(`));
  assert.deepEqual(missing, [], `a contract promises functions the helpers do not define: ${missing.join(", ")}`);
});

check("a skill script finds the helper through the exported path, not by walking up", () => {
  const filler = fs.readFileSync(path.join(ROOT, "resources/skills-catalog/lily-pdf-form/scripts/fill_pdf_form.py"), "utf8");
  assert.match(filler, /os\.environ\.get\("LILY_RUNTIME_SCRIPTS"\)/,
    "walking up from a skill directory can land on a different build");
});

console.log(`\n${checks} checks passed (runtime helper path)`);
