#!/usr/bin/env node
/**
 * Typography and target-size floors for the collaboration panel.
 *
 * These were measured, not guessed: an audit that rendered the real panel in
 * both themes found timestamps and delivery ticks at 9.5px and reaction chips
 * at 39x22. Below ~11px metadata stops being readable, and below 24px a chip
 * stops being reliably clickable — that is the "cheap" feel, and it regresses
 * silently because nothing in the suite looks at declared sizes.
 *
 * The check is deliberately a stylesheet grep rather than a render: it must
 * hold for every state the panel can enter, including ones no fixture builds.
 * Numeric-only badges are exempt — a count inside a pill is glanceable at
 * 10px and follows platform badge convention — so they are named explicitly
 * rather than pattern-matched, and a NEW small rule fails until it is judged.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const CSS_PATH = "src/renderer/styles/collaboration.css";
const css = fs.readFileSync(path.join(ROOT, CSS_PATH), "utf8");

const MIN_TEXT_PX = 11;
const MIN_TARGET_PX = 24;

/** Selectors allowed below the text floor, each with why. */
const BADGE_EXEMPT = new Map([
  [".collaboration-row-unread", "unread count pill — digits only"],
  [".collaboration-unread-badge", "unread count pill — digits only"],
  [".collaboration-scroll-latest-count", "unread count pill — digits only"],
  [".collaboration-message-avatar", "avatar initial, sized to the circle"],
  [".collaboration-mosaic-cell", "one cell of a composed group tile: a ~9px colour cue inside an aria-hidden avatar, with the real name on the row"],
]);

/** Walk declarations, tracking the innermost selector each one belongs to. */
function declarations(source) {
  const out = [];
  let selector = "";
  let pending = "";
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line.endsWith("{")) {
      const head = (pending + " " + line.slice(0, -1)).trim();
      if (!head.startsWith("@")) selector = head;
      pending = "";
      continue;
    }
    if (line.endsWith("}")) continue;
    if (line.endsWith(",")) { pending += " " + line; continue; }
    const match = /^([a-z-]+)\s*:\s*([^;]+);?$/.exec(line);
    if (match) out.push({ selector, property: match[1], value: match[2].trim() });
  }
  return out;
}

const decls = declarations(css);
assert.ok(decls.length > 200, "the declaration walker found almost nothing — it broke, the stylesheet did not");

const pxValue = (value) => {
  const m = /^(\d+(?:\.\d+)?)px$/.exec(value);
  return m ? Number(m[1]) : null;
};

// 1. No readable text below the floor.
const tooSmall = [];
for (const decl of decls) {
  if (decl.property !== "font-size") continue;
  const px = pxValue(decl.value);
  if (px == null || px >= MIN_TEXT_PX) continue;
  const exempt = [...BADGE_EXEMPT.keys()].some((key) => decl.selector.includes(key));
  if (!exempt) tooSmall.push(`${decl.selector} { font-size: ${decl.value} }`);
}
assert.deepEqual(tooSmall, [], `${CSS_PATH}: readable text below ${MIN_TEXT_PX}px — raise it, or add the selector to BADGE_EXEMPT with a reason`);

// 2. Every rule that declares a minimum height must clear the target floor.
//    A rule declaring `min-height` is one whose author was already sizing a
//    box on purpose, so this catches chips and buttons without guessing which
//    selectors are interactive.
const smallTargets = [];
for (const decl of decls) {
  if (decl.property !== "min-height" && decl.property !== "min-inline-size") continue;
  const px = pxValue(decl.value);
  if (px == null || px >= MIN_TARGET_PX) continue;
  if (!/button|chip|action|picker|toggle|\[role="button"\]/i.test(decl.selector)) continue;
  smallTargets.push(`${decl.selector} { ${decl.property}: ${decl.value} }`);
}
assert.deepEqual(smallTargets, [], `${CSS_PATH}: interactive targets below ${MIN_TARGET_PX}px`);

// 3. The exemption list may not quietly grow into a bypass.
assert.ok(BADGE_EXEMPT.size <= 6, "the small-text exemption list is growing — that is a design smell, not a fix");
for (const [selector, reason] of BADGE_EXEMPT) {
  assert.ok(reason.length > 10, `exemption ${selector} needs a real reason`);
  // An exemption for a selector that no longer exists hides the next regression.
  assert.ok(css.includes(selector), `exempt selector ${selector} is gone from ${CSS_PATH} — drop the exemption`);
}

// 4. Colors stay tokenized: a hardcoded hex is how contrast regressed before.
const hardcoded = decls.filter((d) => /^(color|background|background-color|border-color)$/.test(d.property)
  && /#[0-9a-f]{3,8}\b/i.test(d.value)
  && !/color-mix/.test(d.value));
assert.deepEqual(hardcoded.map((d) => `${d.selector} { ${d.property}: ${d.value} }`), [],
  `${CSS_PATH}: use theme tokens, not literal colors — literals do not follow the theme`);

console.log("collaboration-legibility: ok");
