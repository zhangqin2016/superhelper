#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyStatusDisplay } from "../src/renderer/modules/turn-status-dom.js";

function statusEl() {
  const classes = new Set();
  return {
    hidden: false,
    textContent: "",
    dataset: {},
    style: { fontSize: "12px", fontWeight: "700", lineHeight: "18px" },
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
  };
}

const empty = statusEl();
applyStatusDisplay(empty, "");
assert.equal(empty.hidden, true, "empty status text should hide the status node");
assert.equal(empty.textContent, "", "empty status text should not write stale content");

const live = statusEl();
applyStatusDisplay(live, "Working", { live: true });
assert.equal(live.hidden, false);
assert.equal(live.textContent, "Working");
assert.equal(live.dataset.lastText, "Working");
assert.equal(live.dataset.liveStyle, "1");
assert.equal(live.classList.contains("is-live-status"), true);
assert.equal(live.classList.contains("is-sealed-duration"), false);
assert.equal(live.style.fontSize, "", "live style changes should clear stale inline font size");
assert.equal(live.style.fontWeight, "", "live style changes should clear stale inline font weight");
assert.equal(live.style.lineHeight, "", "live style changes should clear stale inline line height");

live.style.fontSize = "13px";
applyStatusDisplay(live, "Working", { live: true });
assert.equal(live.style.fontSize, "13px", "same live mode and text should avoid redundant style work");

applyStatusDisplay(live, "12s", { sealed: true, live: false });
assert.equal(live.textContent, "12s");
assert.equal(live.dataset.liveStyle, "0");
assert.equal(live.classList.contains("is-live-status"), false);
assert.equal(live.classList.contains("is-sealed-duration"), true);
assert.equal(live.style.fontSize, "", "switching to sealed mode should clear stale inline font size");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererSource = fs.readFileSync(
  path.join(__dirname, "../src/renderer/modules/turn-view-renderer.js"),
  "utf8",
);
assert.equal(
  rendererSource.includes("function applyStatusDisplay"),
  false,
  "turn-view-renderer should consume the status DOM helper instead of owning it",
);

console.log("turn-status-dom: ok");
