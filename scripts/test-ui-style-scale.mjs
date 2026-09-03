#!/usr/bin/env node
/**
 * The design scale is enforced, not just declared.
 *
 * base.css defines a type scale (--text-xs/sm/base/md) and a radius scale
 * (--radius-xs/sm/--radius/--radius-lg/--radius-pill). A whole-app audit on
 * 2026-09-03 found them consumed 26 and 159 times respectively, against ~500
 * literal font sizes (30 distinct values, 25 of them under 11px) and ~250
 * literal radii (40 distinct values). That is what "looks generated" measures
 * as: every feature hand-tuned, nothing shared.
 *
 * Two kinds of rule:
 *   HARD  — a literal that IS a scale value (12px, 6px, 999px …) must be the
 *           token. Value-preserving, so there is never a reason not to.
 *   RATCHET — everything else (off-scale sizes, sub-11px text, odd weights,
 *           literal shadows, magic z-index) is counted per file and may only
 *           go down. Baseline in ui-style-scale-baseline.json; regenerate with
 *           --write-baseline only after lowering a count on purpose.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const STYLES = path.join(ROOT, "src/renderer/styles");
const BASELINE = path.join(ROOT, "scripts/ui-style-scale-baseline.json");
const writeBaseline = process.argv.includes("--write-baseline");

const TEXT_TOKENS = { "11px": "--text-xs", "12px": "--text-sm", "13px": "--text-base", "15px": "--text-md" };
const RADIUS_TOKENS = { "4px": "--radius-xs", "6px": "--radius-sm", "10px": "--radius", "14px": "--radius-lg", "999px": "--radius-pill" };
const WEIGHTS = new Set(["400", "500", "600", "700", "normal", "bold", "inherit"]);
const Z_PLAIN = new Set(["0", "1", "2", "3", "-1", "auto"]);
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// The scale tokens must still mean what the HARD rule assumes.
{
  const base = fs.readFileSync(path.join(STYLES, "base.css"), "utf8");
  for (const [value, token] of [...Object.entries(TEXT_TOKENS), ...Object.entries(RADIUS_TOKENS)]) {
    assert.match(base, new RegExp(`${token.replace(/[-]/g, "\\-")}:\\s*${value};`), `base.css defines ${token}: ${value}`);
  }
}

const hard = [];
const counts = {};
for (const file of fs.readdirSync(STYLES).filter((f) => f.endsWith(".css") && f !== "base.css").sort()) {
  const css = stripComments(fs.readFileSync(path.join(STYLES, file), "utf8"));
  const c = { fontSizeOffScale: 0, fontSizeBelow11: 0, radiusOffScale: 0, weightOffScale: 0, shadowLiteral: 0, zIndexLiteral: 0 };
  for (const m of css.matchAll(/font-size:\s*([^;{}]+);/g)) {
    const v = m[1].trim();
    if (TEXT_TOKENS[v]) hard.push(`${file}: font-size: ${v} → use var(${TEXT_TOKENS[v]})`);
    else if (/^\d+(\.\d+)?px$/.test(v)) { c.fontSizeOffScale += 1; if (parseFloat(v) < 11) c.fontSizeBelow11 += 1; }
  }
  for (const m of css.matchAll(/border(?:-[a-z-]+)?-radius:\s*([^;{}]+);/g)) {
    for (const v of m[1].trim().split(/\s+/)) {
      if (RADIUS_TOKENS[v]) hard.push(`${file}: border-radius ${v} → use var(${RADIUS_TOKENS[v]})`);
      else if (/^\d+(\.\d+)?px$/.test(v) && v !== "0px") c.radiusOffScale += 1;
    }
  }
  for (const m of css.matchAll(/font-weight:\s*([^;{}]+);/g)) { if (!WEIGHTS.has(m[1].trim()) && !m[1].includes("var(")) c.weightOffScale += 1; }
  for (const m of css.matchAll(/box-shadow:\s*([^;{}]+);/g)) { const v = m[1].trim(); if (v !== "none" && !v.startsWith("var(")) c.shadowLiteral += 1; }
  for (const m of css.matchAll(/z-index:\s*([^;{}]+);/g)) { const v = m[1].trim(); if (!Z_PLAIN.has(v) && !v.startsWith("var(")) c.zIndexLiteral += 1; }
  counts[file] = c;
}

if (writeBaseline) {
  fs.writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + "\n");
  console.log(`ui-style-scale: baseline written (${Object.keys(counts).length} files)`);
}
assert.deepEqual(hard, [], `scale values must be tokens (${hard.length}):\n  ${hard.slice(0, 20).join("\n  ")}`);

const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const worse = [];
const better = [];
for (const [file, c] of Object.entries(counts)) {
  const b = baseline[file] || Object.fromEntries(Object.keys(c).map((k) => [k, 0]));
  for (const [k, v] of Object.entries(c)) {
    if (v > b[k]) worse.push(`${file} ${k}: ${b[k]} → ${v}`);
    else if (v < b[k]) better.push(`${file} ${k}: ${b[k]} → ${v}`);
  }
}
assert.deepEqual(worse, [], `style-scale ratchet went the wrong way:\n  ${worse.join("\n  ")}`);
const totals = Object.values(counts).reduce((acc, c) => { for (const [k, v] of Object.entries(c)) acc[k] = (acc[k] || 0) + v; return acc; }, {});
console.log(`ui-style-scale: ok — hard rule clean; ratchet ${JSON.stringify(totals)}${better.length ? `; ${better.length} counts below baseline (tighten with --write-baseline)` : ""}`);
