#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STYLES_DIR = path.join(ROOT, "src/renderer/styles");

function walkCssFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkCssFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".css")) files.push(full);
  }
  return files;
}

const definitionRe = /--([A-Za-z0-9_-]+)\s*:/g;
const usageRe = /var\(\s*(--[A-Za-z0-9_-]+)/g;
const negativeLetterSpacingRe = /letter-spacing\s*:\s*-[^;]+;/g;
const defined = new Set();
const usages = [];
const negativeLetterSpacing = [];

for (const file of walkCssFiles(STYLES_DIR)) {
  const rel = path.relative(ROOT, file);
  const css = fs.readFileSync(file, "utf8");
  for (const match of css.matchAll(definitionRe)) defined.add(`--${match[1]}`);
  for (const match of css.matchAll(usageRe)) usages.push({ token: match[1], rel });
  for (const match of css.matchAll(negativeLetterSpacingRe)) {
    negativeLetterSpacing.push(`${rel}: ${match[0]}`);
  }
}

const missing = usages
  .filter(({ token }) => !defined.has(token))
  .map(({ token, rel }) => `${token} used by ${rel}`)
  .sort();

assert.deepEqual(
  missing,
  [],
  `renderer CSS must not reference undefined theme tokens:\n${missing.join("\n")}`,
);

assert.deepEqual(
  negativeLetterSpacing,
  [],
  `renderer CSS must not use negative letter-spacing:\n${negativeLetterSpacing.join("\n")}`,
);

console.log("renderer CSS token guard: ok");
