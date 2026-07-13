#!/usr/bin/env node
// "Load older history on scroll-to-top" must only fire when the panel actually
// scrolls. Regression: during task execution a short (fits-viewport) conversation
// has scrollTop ~0, so the streaming auto-scroll-to-bottom spuriously triggered a
// history load that yanked the view to the very top.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  elementScrollTargetTop,
  nextAutoFollowDetachedState,
  normalizeWheelDelta,
  revealScrollIntent,
  shouldLoadOlderOnScroll,
  shouldMarkBoundaryGesture,
  OLDER_LOAD_TOP_THRESHOLD,
} from "../src/renderer/modules/scroll-geometry.js";

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

assert.equal(normalizeWheelDelta({ deltaY: 2, deltaMode: 1, rootHeight: 500 }), 80, "line wheel delta matches OpenCode behavior");
assert.equal(normalizeWheelDelta({ deltaY: 1, deltaMode: 2, rootHeight: 500 }), 500, "page wheel delta uses root height");
assert.equal(normalizeWheelDelta({ deltaY: 12, deltaMode: 0, rootHeight: 500 }), 12, "pixel wheel delta passes through");

assert.equal(shouldMarkBoundaryGesture({ delta: -10, scrollTop: 0, scrollHeight: 2000, clientHeight: 500 }), true, "wheeling upward at top marks boundary");
assert.equal(shouldMarkBoundaryGesture({ delta: -10, scrollTop: 300, scrollHeight: 2000, clientHeight: 500 }), false, "middle upward wheel is not boundary");
assert.equal(shouldMarkBoundaryGesture({ delta: 100, scrollTop: 1460, scrollHeight: 2000, clientHeight: 500 }), true, "wheeling past bottom marks boundary");

assert.deepEqual(revealScrollIntent({ savedScrollTop: 320, hasRenderedContent: true }), { mode: "restore", scrollTop: 320 }, "existing session restores saved scroll");
assert.deepEqual(revealScrollIntent({ savedScrollTop: 320, hasRenderedContent: false }), { mode: "bottom" }, "empty session still opens at bottom");
assert.deepEqual(revealScrollIntent({ savedScrollTop: null, hasRenderedContent: true }), { mode: "bottom" }, "first reveal opens at bottom");

assert.equal(
  nextAutoFollowDetachedState({
    previousDetached: false,
    hasUserScrollIntent: false,
    programmaticScroll: false,
    userScrolledUp: false,
    nearBottom: false,
  }),
  false,
  "layout-only scroll after auto-follow must not detach from latest",
);
assert.equal(
  nextAutoFollowDetachedState({
    previousDetached: false,
    hasUserScrollIntent: true,
    programmaticScroll: false,
    userScrolledUp: true,
    nearBottom: false,
  }),
  true,
  "real upward user scroll detaches auto-follow",
);
assert.equal(
  nextAutoFollowDetachedState({
    previousDetached: true,
    hasUserScrollIntent: false,
    programmaticScroll: true,
    userScrolledUp: false,
    nearBottom: true,
  }),
  false,
  "programmatic scroll to bottom reattaches auto-follow",
);

assert.equal(
  elementScrollTargetTop({
    panelTop: 100,
    elementTop: 240,
    scrollTop: 300,
    scrollHeight: 1200,
    clientHeight: 400,
  }),
  428,
  "jump target keeps the selected element slightly below the panel top",
);
assert.equal(
  elementScrollTargetTop({
    panelTop: 100,
    elementTop: 50,
    scrollTop: 20,
    scrollHeight: 1200,
    clientHeight: 400,
  }),
  0,
  "jump target clamps above-start positions to the top",
);
assert.equal(
  elementScrollTargetTop({
    panelTop: 0,
    elementTop: 999,
    scrollTop: 700,
    scrollHeight: 1000,
    clientHeight: 300,
  }),
  700,
  "jump target clamps past-end positions to the maximum scroll top",
);
assert.equal(elementScrollTargetTop(null), 0, "missing geometry fails open to no movement");

const messageSource = readFileSync(new URL("../src/renderer/modules/message.js", import.meta.url), "utf8");
assert.match(messageSource, /elementScrollTargetTop\(/);
assert.doesNotMatch(messageSource, /getBoundingClientRect\(\)\.top - panel\.getBoundingClientRect\(\)\.top \+ panel\.scrollTop - 12/);

console.log("scroll-geometry: ok");
