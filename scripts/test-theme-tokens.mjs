#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stylesDir = join(root, "src/renderer/styles");
const base = readFileSync(join(stylesDir, "base.css"), "utf8");
const indexHtml = readFileSync(join(root, "src/renderer/index.html"), "utf8");
const themeModule = readFileSync(join(root, "src/renderer/modules/theme-settings.js"), "utf8");

function tokens(block) {
  const out = new Map();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out.set(m[1], m[2].trim());
  return out;
}

const rootBlock = base.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
const lightBlock = base.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)[1];
const darkTokens = tokens(rootBlock);
const lightTokens = tokens(lightBlock);

// 1) Theme parity: every color-valued token in :root must be re-themed for light,
//    and light must not invent tokens that dark lacks (aliases via var() are exempt).
const COLORISH = /#|rgba?\(|color-mix\(/;
const themedNames = [...darkTokens].filter(([, v]) => COLORISH.test(v)).map(([n]) => n);
for (const name of themedNames) {
  assert.ok(lightTokens.has(name), `light theme missing re-theme of ${name}`);
}
for (const name of lightTokens.keys()) {
  if (name === "--color-scheme") continue;
  assert.ok(darkTokens.has(name), `light theme defines unknown token ${name}`);
}

// 2) Structural contract inherited from the previous version of this test.
for (const token of [
  "--color-scheme", "--text-xs", "--text-sm", "--text-base", "--text-md",
  "--bg-surface-hover", "--bg-backdrop", "--text-inverse",
  "--success-bg", "--danger-bg", "--warning-bg", "--info-bg",
  "--diff-add-bg", "--code-bg", "--pre-bg", "--image-backdrop", "--scrollbar-thumb",
]) {
  assert.ok(base.includes(token), `base.css is missing theme token ${token}`);
}
assert.ok(base.includes(':root[data-text-size="large"]'), "base.css must define a large text-size block");

const selfReferences = [...base.matchAll(/^\s*(--[a-z0-9-]+):\s*var\(\1\)/gim)].map((m) => m[1]);
assert.equal(selfReferences.length, 0, `base.css contains token self references: ${selfReferences.join(", ")}`);

// 3) Current design intent: daylight-minimal light theme with brand violet.
//    (Replaces the previous cool-porcelain assertions removed by the 2026-07-22 overhaul.)
assert.ok(lightBlock.includes("--bg-body: #f7f7f5;"), "light theme body should be warm daylight #f7f7f5");
assert.ok(lightBlock.includes("--accent: #6366f1;"), "light theme accent should be brand violet #6366f1");

// 4) Component CSS must consume tokens, not raw colors
//    (rgba()/rgb() banned outright; hex only for the brand gradient + white).
const HEX_ALLOW = new Set(["#fff", "#ffffff", "#6366f1", "#8b5cf6"]);
for (const file of readdirSync(stylesDir)) {
  if (!file.endsWith(".css") || file === "base.css") continue;
  const css = readFileSync(join(stylesDir, file), "utf8");
  assert.ok(!/rgba?\(/.test(css), `${file}: raw rgba()/rgb() color — use a theme token from base.css`);
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    assert.ok(HEX_ALLOW.has(m[0].toLowerCase()), `${file}: hardcoded color ${m[0]} — use a theme token from base.css`);
  }
}

// 5) Theme application contract (renderer boot + settings UI).
assert.ok(indexHtml.includes("lily.themeMode"), "index.html must apply persisted theme before CSS loads");
assert.ok(indexHtml.includes("lily.textSizeMode"), "index.html must apply persisted text size before CSS loads");
assert.ok(/styles\.css\?v=\d{8}-[a-z0-9-]+/.test(indexHtml), "index.html must cache-bust the stylesheet entry (bump after stylesheet changes)");
assert.ok(indexHtml.includes("themeModeSelect"), "settings UI must expose the theme selector");
assert.ok(indexHtml.includes("textSizeModeSelect"), "settings UI must expose the text-size selector");
assert.ok(themeModule.includes("matchMedia"), "theme-settings.js must support system theme changes");
assert.ok(themeModule.includes("document.documentElement"), "theme-settings.js must apply theme on documentElement");
assert.ok(themeModule.includes("dataset.textSize"), "theme-settings.js must apply text size on documentElement");

console.log(`theme tokens ok: ${themedNames.length} themed tokens checked`);
