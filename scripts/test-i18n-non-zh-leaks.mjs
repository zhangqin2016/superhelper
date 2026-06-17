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

for (const locale of ["en", "ar"]) {
  const file = path.join(ROOT, "src/renderer/i18n/locales", `${locale}.json`);
  const messages = JSON.parse(fs.readFileSync(file, "utf8"));
  assertNoHan(`renderer.${locale}`, messages, new Set(["settings.language.zh-CN"]));
}

for (const locale of ["en", "ar"]) {
  const file = path.join(ROOT, "src/renderer/i18n/locales/skills", `${locale}.json`);
  const messages = JSON.parse(fs.readFileSync(file, "utf8"));
  assertNoHan(`renderer.skills.${locale}`, messages);
}

console.log("i18n non-zh leak guard: ok");
