#!/usr/bin/env node
/**
 * Timeline UI contract. This is a static guard because renderer modules run in
 * Electron, but these assertions protect the interaction decisions that make
 * long-running agent work feel alive.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const timeline = fs.readFileSync(new URL("../src/renderer/modules/turn-timeline.js", import.meta.url), "utf8");
const message = fs.readFileSync(new URL("../src/renderer/modules/message.js", import.meta.url), "utf8");
const markdown = fs.readFileSync(new URL("../src/renderer/modules/markdown.js", import.meta.url), "utf8");
const dom = fs.readFileSync(new URL("../src/renderer/modules/dom.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

assert.match(timeline, /Turn Timeline/, "turn activity must be owned by the unified timeline renderer");
assert.match(timeline, /timeline\.statusRunning/, "timeline rows must show a running status");
assert.match(timeline, /timeline\.statusDone/, "timeline rows must show a completed status");
assert.match(timeline, /timeline\.statusDetached/, "detached tools must be marked as background work");
assert.match(timeline, /syncSummary/, "completed tools must aggregate into a useful timeline summary");
assert.match(timeline, /timeline\.summaryRead/, "tool summaries must distinguish read work from generic steps");
assert.match(timeline, /timeline\.summaryCommand/, "tool summaries must distinguish command execution from generic steps");
assert.doesNotMatch(
  timeline,
  /activity\.classList\.add\("tool-steps-compact",\s*"tool-collapsed"\)/,
  "tool history must not be collapsed by default",
);

assert.match(message, /from "\.\/turn-timeline\.js"/, "message UI must use the unified timeline renderer");
assert.doesNotMatch(message, /from "\.\/tool-cards\.js"/, "message UI must not use the old tool-card renderer");
assert.doesNotMatch(message, /from "\.\/engine-notices\.js"/, "message UI must not use the old engine notice renderer");
assert.match(message, /turn-queue-slot/, "queued messages must render inside the active turn");
assert.match(message, /renderInlineTurnQueue/, "active turn queue renderer must exist");
assert.match(message, /cancelQueuedMessage/, "inline queue rows must remain cancellable");
assert.match(message, /finishEngineNotices\(v\)/, "running process notices must settle when the turn finishes");

assert.match(timeline, /LIVE_TICK_MS/, "thinking progress must refresh while Claude is working");
assert.match(timeline, /code !== "thinkingProgress"/, "only live thinking notices should run timers");
assert.match(timeline, /entry\.payload = \{ \.\.\.entry\.payload, \.\.\.payload \}/, "replaceable engine notices must update one row instead of duplicating");
assert.match(timeline, /export function finishTimeline/, "timeline needs an explicit turn completion path");

assert.match(css, /\.tool-cards-wrap\s*\{\s*display:\s*flex/s, "historical tool steps must be visible");
assert.match(css, /\.turn-timeline/, "timeline shell must have dedicated styling hooks");
assert.match(css, /\.turn-queue-slot/, "inline queue must have a visible timeline style");
assert.match(css, /\.tool-card-status/, "tool cards must include a status pill");

// Streaming rendering
assert.match(markdown, /export function renderStreamingMarkdown/, "streaming markdown renderer must exist");
assert.match(markdown, /window\.DOMPurify\.sanitize\(html\)/, "streaming markdown must sanitize output");

// Timeline text entries (continuous flow)
assert.match(timeline, /export function addTextEntry/, "timeline must support inline text entries");
assert.match(timeline, /export function updateTextEntry/, "text entries must update with streaming markdown");
assert.match(timeline, /export function finalizeTextEntry/, "text entries must finalize with full highlight");
assert.match(timeline, /TEXT_RENDER_MS/, "text entry updates must be throttled");
assert.match(message, /addTextEntry\(v\)/, "message.js must create text entry in timeline on first chunk");
assert.match(message, /updateTextEntry\(v, v\.activeMarkdown\)/, "message.js must update text entry during streaming");
assert.match(message, /finalizeTextEntry\(v, softenStreamGlue/, "message.js must finalize text entry on turn done");

// onDone cleanup
assert.match(message, /article\.classList\.remove\("is-running"\)/, "onDone must remove is-running from article");

// Fallback suppression during streaming
assert.match(timeline, /activeBubble\?\.dataset\?\.streamMode \|\| viewState\.activeMarkdown/, "syncTurnProgress must skip fallback during streaming");

// Scroll throttle
assert.match(dom, /export function scrollToBottomThrottled/, "dom.js must export throttled scroll");

// CSS for continuous flow
assert.match(css, /\.turn-text-entry/, "timeline text entries must have dedicated CSS");
assert.match(css, /\.turn-text-entry-final/, "finalized text entries must have a settled state");
assert.match(css, /animation: fade-in 0\.2s ease-out;/, "permission prompt must fade in");
assert.match(css, /transition: background 0\.3s, box-shadow 0\.4s, color 0\.3s/, "avatar must have state transitions");

// No double overflow
assert.doesNotMatch(css, /\.messages\s*\{\s*flex: 1;\s*overflow-y: auto;/, "inner messages must not have overflow (parent scrolls)");

console.log("agent-timeline-ui: ok");
