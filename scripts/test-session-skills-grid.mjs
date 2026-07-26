#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

const composerCss = read("src/renderer/styles/composer.css");
const sharedTreeCss = read("src/renderer/styles/skills-tree.css");
const systemCss = read("src/renderer/styles/system.css");

assert.match(
  composerCss,
  /\.session-skills-popover-list\s*\{[^}]*container-type:\s*inline-size[^}]*container-name:\s*session-skills-list/s,
  "the session skill list must establish a named inline-size container",
);
assert.match(
  composerCss,
  /@supports\s*\(container-type:\s*inline-size\)[\s\S]*?\.session-skills-popover-list\s+\.skills-tree-group--expanded\s+\.skills-tree-group-children\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
  "expanded session categories must use a three-column grid when supported",
);
assert.match(
  composerCss,
  /@container\s+session-skills-list\s*\(max-width:\s*560px\)[\s\S]*?\.session-skills-popover-list\s+\.skills-tree-group--expanded\s+\.skills-tree-group-children\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
  "medium session skill lists must use two columns",
);
assert.match(
  composerCss,
  /@container\s+session-skills-list\s*\(max-width:\s*360px\)[\s\S]*?\.session-skills-popover-list\s+\.skills-tree-group--expanded\s+\.skills-tree-group-children\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  "narrow session skill lists must return to one column",
);

const scopedRowRule =
  composerCss.match(
    /\.session-skills-popover-list\s+\.skills-tree-row\s*\{[^}]*\}/s,
  )?.[0] || "";
for (const contract of [
  "min-height: 38px",
  "min-width: 0",
  "padding: 8px 10px",
  "border-inline-end: 1px solid var(--border)",
  "border-block-end: 1px solid var(--border)",
]) {
  assert.ok(
    scopedRowRule.includes(contract),
    `session skill grid cells must include ${contract}`,
  );
}
assert.match(
  composerCss,
  /\.session-skills-popover-list\s+\.skills-tree-row::before\s*\{[^}]*display:\s*none/s,
  "grid cells must remove the vertical tree connector",
);
assert.match(
  composerCss,
  /\.session-skills-popover-list\s+\.skills-tree-row-name\s*\{[^}]*min-width:\s*0[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s,
  "long session skill names must truncate inside their cell",
);
assert.match(
  composerCss,
  /\.session-skills-popover-list\s+\.skills-tree-row-badge\s*\{[^}]*max-width:\s*64px[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s,
  "the global-disabled badge must not resize neighboring cells",
);
assert.match(
  systemCss,
  /\[dir="rtl"\]\s+\.session-skills-popover-list\s+\.skills-tree-row\s*\{[^}]*padding:\s*8px 10px/s,
  "RTL must retain the compact session-grid cell padding",
);

assert.doesNotMatch(
  sharedTreeCss,
  /\.skills-tree-group--expanded\s+\.skills-tree-group-children\s*\{[^}]*display:\s*grid/s,
  "the shared settings tree must remain a vertical list",
);
assert.doesNotMatch(
  composerCss.replace(/\/\*[\s\S]*?\*\//g, ""),
  /#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\s*\(/i,
  "session grid styling must continue to use theme tokens",
);

console.log("session-skills-grid: ok");
