#!/usr/bin/env node
/**
 * No dead declarations in the collaboration stylesheet.
 *
 * This sheet grew through a dozen passes, each appending a new block for a
 * selector it had already styled. The result was 82 declarations that could
 * never take effect — the same selector re-declared the same property later,
 * so the earlier one always lost — and, worse, a reader could not tell which
 * value was live. That is not cosmetic: two real bugs this session came from
 * exactly this layering.
 *
 *   - the nav rail rendered its three icons side by side over the list,
 *     because `.collaboration-nav` sets `display: grid` and is declared LATER
 *     than the rail's own rule, so the rail lost on source order.
 *   - a member-pick row measured 77px instead of 56px, because
 *     `.collaboration-social-form label` sets `display: grid` and, being
 *     class+element, outranked the single-class row rule.
 *
 * The check is deliberately narrow, so it can never be wrong: a declaration is
 * dead only when the SAME selector text declares the SAME property again later
 * at top level, with neither marked `!important`. Identical selector text means
 * an identical match set, so the later declaration always wins. Rules inside
 * `@media` are ignored on both sides — one of those does not unconditionally
 * win, so it must not count as an override.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const FILES = ["src/renderer/styles/collaboration.css"];

/** Top-level blocks, skipping comments so a brace inside one cannot mislead. */
function topLevelBlocks(source) {
  const blocks = [];
  let depth = 0;
  let headStart = 0;
  let openAt = 0;
  for (let i = 0; i < source.length;) {
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    const ch = source[i];
    if (ch === "{") {
      if (depth === 0) openAt = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        blocks.push({ head: source.slice(headStart, openAt), body: source.slice(openAt + 1, i) });
        headStart = i + 1;
      }
    }
    i += 1;
  }
  return blocks;
}

/** Declarations as written — shorthands stay shorthands. */
function declarations(body) {
  const found = [];
  for (let i = 0; i < body.length;) {
    if (body.startsWith("/*", i)) {
      const end = body.indexOf("*/", i + 2);
      i = end < 0 ? body.length : end + 2;
      continue;
    }
    const match = /^([a-z-]+)\s*:\s*([^;{}]*);/.exec(body.slice(i));
    if (match) {
      found.push({ property: match[1], value: match[2].trim() });
      i += match[0].length;
      continue;
    }
    i += 1;
  }
  return found;
}

const normalize = (head) => head.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();

for (const file of FILES) {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8");
  const blocks = topLevelBlocks(source)
    .map((block) => ({ selector: normalize(block.head), declarations: declarations(block.body) }))
    // An at-rule's own body holds nested blocks, and a nested rule does not
    // unconditionally override anything, so at-rules are out of scope.
    .filter((block) => block.selector && !block.selector.startsWith("@"));

  assert.ok(blocks.length > 100, `the block scan found only ${blocks.length} rules — it broke, the stylesheet did not`);

  const bySelector = new Map();
  blocks.forEach((block, index) => {
    if (!bySelector.has(block.selector)) bySelector.set(block.selector, []);
    bySelector.get(block.selector).push(index);
  });

  const dead = [];
  for (const [selector, indexes] of bySelector) {
    if (indexes.length < 2) continue;
    indexes.slice(0, -1).forEach((index, position) => {
      const later = new Set();
      for (const other of indexes.slice(position + 1)) {
        for (const declaration of blocks[other].declarations) {
          if (!declaration.value.includes("!important")) later.add(declaration.property);
        }
      }
      for (const declaration of blocks[index].declarations) {
        if (declaration.value.includes("!important")) continue;
        if (later.has(declaration.property)) dead.push(`${selector} { ${declaration.property}: ${declaration.value} }`);
      }
    });
  }

  assert.deepEqual(dead, [], `${file}: these declarations can never take effect — the same selector sets the same property again later.\n`
    + "Merge the value into the later block instead of layering another one, so a reader can tell which value is live:\n  "
    + dead.slice(0, 12).join("\n  "));

  // The duplicate-block count is allowed but tracked: a selector styled in
  // several places is where the two layering bugs came from, so it should not
  // quietly grow. This is a ratchet, not a ban — some duplicates carry
  // different concerns and read better apart.
  const duplicated = [...bySelector.values()].filter((indexes) => indexes.length > 1).length;
  // 28 is the count after the dead declarations were removed, so the ratchet
  // is the measured floor rather than a round number left with slack in it.
  assert.ok(duplicated <= 28,
    `${file}: ${duplicated} selectors are styled in more than one block (ratchet 28). Add to an existing block rather than appending a new one.`);
}

// A conversation/contact row must never carry `content-visibility: auto`.
// It forces `contain: size` on both axes, and before a row's size is first
// remembered the width falls back to `contain-intrinsic-size` (~56px), so a
// freshly opened or detached panel laid not-yet-settled rows out in a narrow
// box and the flex row collapsed into a vertical stack with an unreadable
// title. See collaboration.css. Virtualisation is the right tool if the
// lists ever need it.
{
  const css = fs.readFileSync(path.join(ROOT, "src/renderer/styles/collaboration.css"), "utf8");
  const rowRules = [...css.matchAll(/\.collaboration-(?:inbox-item|social-row)[^{}]*\{([^{}]*)\}/g)];
  for (const [, body] of rowRules) {
    assert.ok(!/content-visibility\s*:\s*auto/.test(body),
      "conversation/contact rows must not use content-visibility:auto — it collapses not-yet-settled rows");
  }
}

console.log("collaboration-css-no-dead-rules: ok");
