#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderFooter } from "../src/renderer/modules/turn-footer.js";

const root = {
  textContent: "stale",
  hidden: false,
};
renderFooter(root);
assert.equal(root.textContent, "", "footer render should clear stale text");
assert.equal(root.hidden, true, "footer render should hide the footer until it has content");

renderFooter(null);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = fs.readFileSync(
  path.join(__dirname, "../src/renderer/modules/turn-view-renderer.js"),
  "utf8",
);
assert.equal(
  rendererSource.includes("function renderFooter"),
  false,
  "turn-view-renderer should consume the footer helper instead of owning it",
);

console.log("turn-footer: ok");
