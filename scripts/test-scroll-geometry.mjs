#!/usr/bin/env node
// "Load older history on scroll-to-top" must only fire when the panel actually
// scrolls. Regression: during task execution a short (fits-viewport) conversation
// has scrollTop ~0, so the streaming auto-scroll-to-bottom spuriously triggered a
// history load that yanked the view to the very top.
import assert from "node:assert/strict";
import { shouldLoadOlderOnScroll, OLDER_LOAD_TOP_THRESHOLD } from "../src/renderer/modules/scroll-geometry.js";

const panel = (scrollHeight, clientHeight, scrollTop) => ({ scrollHeight, clientHeight, scrollTop });

// fits the viewport (top == bottom): never load — this is the bug being fixed
assert.equal(shouldLoadOlderOnScroll(panel(500, 500, 0)), false, "non-scrollable panel must not load older");
assert.equal(shouldLoadOlderOnScroll(panel(540, 500, 0)), false, "barely-overflowing (<= threshold) must not load");

// genuinely overflowing
assert.equal(shouldLoadOlderOnScroll(panel(2000, 500, 0)), true, "overflowing + at top loads older");
assert.equal(shouldLoadOlderOnScroll(panel(2000, 500, OLDER_LOAD_TOP_THRESHOLD)), true, "at the threshold loads older");
assert.equal(shouldLoadOlderOnScroll(panel(2000, 500, OLDER_LOAD_TOP_THRESHOLD + 1)), false, "just past the threshold does not");
assert.equal(shouldLoadOlderOnScroll(panel(2000, 500, 1490)), false, "overflowing + at bottom must not load older");

assert.equal(shouldLoadOlderOnScroll(null), false, "null panel is safe");

console.log("scroll-geometry: ok");
