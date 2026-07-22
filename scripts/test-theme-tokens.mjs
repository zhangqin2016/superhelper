#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stylesDir = join(root, "src/renderer/styles");
const base = readFileSync(join(stylesDir, "base.css"), "utf8");

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

// 2) Component CSS must consume tokens, not hardcode hex (brand gradient + white allowlisted).
const ALLOW = new Set(["#fff", "#ffffff", "#6366f1", "#8b5cf6"]);
for (const file of readdirSync(stylesDir)) {
  if (!file.endsWith(".css") || file === "base.css") continue;
  const css = readFileSync(join(stylesDir, file), "utf8");
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    assert.ok(ALLOW.has(m[0].toLowerCase()), `${file}: hardcoded color ${m[0]} — use a theme token from base.css`);
  }
}

console.log(`theme tokens ok: ${themedNames.length} themed tokens checked`);
