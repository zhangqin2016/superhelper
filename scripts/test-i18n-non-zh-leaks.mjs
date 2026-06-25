#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dictionaries } from "../web/lib/i18n.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HAN_RE = /[\u3400-\u9fff]/;

function collectStrings(value, prefix = "") {
  const rows = [];
  if (typeof value === "string") {
    rows.push([prefix, value]);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => rows.push(...collectStrings(item, `${prefix}[${index}]`)));
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      rows.push(...collectStrings(nested, prefix ? `${prefix}.${key}` : key));
    }
  }
  return rows;
}

function collectMissingKeys(base, candidate, prefix = "") {
  const missing = [];
  if (!base || typeof base !== "object" || Array.isArray(base)) return missing;
  for (const key of Object.keys(base)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (!candidate || typeof candidate !== "object" || !(key in candidate)) {
      missing.push(nextPath);
      continue;
    }
    missing.push(...collectMissingKeys(base[key], candidate[key], nextPath));
  }
  return missing;
}

function assertNoHan(label, value, allow = new Set()) {
  const hits = collectStrings(value)
    .filter(([key, text]) => HAN_RE.test(text) && !allow.has(key))
    .map(([key, text]) => `${label}.${key}: ${text}`);
  assert.deepEqual(hits, [], `${label} must not leak Chinese strings`);
}

for (const locale of ["en", "ar"]) {
  assert.deepEqual(
    collectMissingKeys(dictionaries.zh, dictionaries[locale]),
    [],
    `web ${locale} dictionary must cover every zh key`,
  );
  assertNoHan(`web.${locale}`, dictionaries[locale]);
}

const rendererBaseMessages = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src/renderer/i18n/locales/zh-CN.json"), "utf8"),
);
for (const locale of ["en", "ar"]) {
  const file = path.join(ROOT, "src/renderer/i18n/locales", `${locale}.json`);
  const messages = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(
    collectMissingKeys(rendererBaseMessages, messages),
    [],
    `renderer ${locale} dictionary must cover every zh-CN key`,
  );
  assert.deepEqual(
    collectMissingKeys(messages, rendererBaseMessages),
    [],
    `renderer ${locale} dictionary must not define keys missing from zh-CN`,
  );
  assertNoHan(`renderer.${locale}`, messages, new Set(["settings.language.zh-CN"]));
}

for (const locale of ["en", "ar"]) {
  const file = path.join(ROOT, "src/renderer/i18n/locales/skills", `${locale}.json`);
  const messages = JSON.parse(fs.readFileSync(file, "utf8"));
  assertNoHan(`renderer.skills.${locale}`, messages);
}

// Hardcoded Chinese in renderer JS bypasses i18n entirely, so it shows in EVERY
// locale (en/ar included). Strip comments, then any remaining Han is a string
// literal that must be moved to a t() key. This is what caught the leak in
// connector-settings.js / migration-progress.js.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// Only quoted STRING literals carry UI text; regex literals (e.g. matching the
// user's "记住"/remember keyword) legitimately contain Chinese and must not trip.
const STRING_LITERAL_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
const rendererJsLeaks = [];
function walkJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}
for (const file of walkJsFiles(path.join(ROOT, "src/renderer"))) {
  const rel = path.relative(ROOT, file);
  const code = stripComments(fs.readFileSync(file, "utf8"));
  code.split("\n").forEach((line, index) => {
    const literals = line.match(STRING_LITERAL_RE) || [];
    if (literals.some((lit) => HAN_RE.test(lit))) {
      rendererJsLeaks.push(`${rel}:${index + 1}: ${line.trim().slice(0, 90)}`);
    }
  });
}
assert.deepEqual(
  rendererJsLeaks,
  [],
  `renderer JS must not hardcode Chinese (use t() instead):\n${rendererJsLeaks.join("\n")}`,
);

console.log("i18n non-zh leak guard: ok");
