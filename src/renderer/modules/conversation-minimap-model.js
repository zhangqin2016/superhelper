/**
 * Conversation minimap — pure model (no DOM/i18n imports, so it is unit-testable).
 *
 * The DOM layer (conversation-minimap.js) extracts a flat `items` array from the
 * rendered chat and asks this module what ribs to draw and which one is active. Keeping
 * this logic pure is the closed-loop guard: scope/depth filtering, outline flattening,
 * and active-rib tracking are all verified in scripts/test-conversation-minimap.mjs.
 */

"use strict";

export const SCOPES = ["all", "prompts"]; // toggle: all turns <-> my prompts only
export const MAX_DEPTH = 3; // heading depth cycle: 0 (none) -> 1 (H1) -> 2 (+H2) -> 3 (+H3)

/** Cycle heading depth 0->1->2->3->0 (matches the ChatGPT Navigator depth cycle). */
export function cycleDepth(depth) {
  const d = Number.isInteger(depth) ? depth : 0;
  return (((d + 1) % (MAX_DEPTH + 1)) + (MAX_DEPTH + 1)) % (MAX_DEPTH + 1);
}

/** Toggle scope all <-> prompts. */
export function nextScope(scope) {
  return scope === "prompts" ? "all" : "prompts";
}

function clampText(text, max = 90) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Flatten the conversation into rib entries.
 * @param {Array<{role:'user'|'assistant', label?:string, turnId?:string,
 *   headings?:Array<{level:number,text:string}>}>} items
 * @param {{scope?:'all'|'prompts', depth?:number, terminus?:boolean}} [opts]
 * @returns {Array<{kind:'prompt'|'response'|'heading'|'terminus', level:number,
 *   label:string, itemIndex:number, headingIndex?:number}>}
 */
export function buildMinimapModel(items = [], opts = {}) {
  const scope = opts.scope === "prompts" ? "prompts" : "all";
  const depth = Math.max(0, Math.min(MAX_DEPTH, Number.isInteger(opts.depth) ? opts.depth : 0));
  const entries = [];
  (Array.isArray(items) ? items : []).forEach((item, itemIndex) => {
    if (!item || (item.role !== "user" && item.role !== "assistant")) return;
    if (item.role === "user") {
      entries.push({ kind: "prompt", level: 0, label: clampText(item.label), itemIndex, turnId: item.turnId || "" });
      return;
    }
    // assistant
    if (scope === "prompts") return; // prompts-only view hides assistant ribs entirely
    entries.push({ kind: "response", level: 0, label: clampText(item.label), itemIndex, turnId: item.turnId || "" });
    if (depth <= 0) return;
    (Array.isArray(item.headings) ? item.headings : []).forEach((h, headingIndex) => {
      const level = Number(h?.level) || 1;
      if (level > depth) return;
      entries.push({ kind: "heading", level, label: clampText(h.text, 70), itemIndex, headingIndex });
    });
  });
  if (opts.terminus && entries.length > 0) {
    entries.push({ kind: "terminus", level: 0, label: clampText(opts.terminusLabel || ""), itemIndex: -1 });
  }
  return entries;
}

/**
 * Which rib is active given the current scroll position. The active rib is the last
 * entry whose offset is at/above an anchor line a little below the viewport top, so the
 * highlight tracks what the reader is actually looking at. Scrolled to the very bottom
 * always selects the last rib (the terminus/streaming tail).
 * @param {number} scrollTop
 * @param {number} viewportHeight
 * @param {number} contentHeight
 * @param {number[]} offsets per-entry offsetTop within the scroll container
 */
export function computeActiveIndex(scrollTop, viewportHeight, contentHeight, offsets = []) {
  const n = Array.isArray(offsets) ? offsets.length : 0;
  if (n === 0) return -1;
  // At the bottom (within 2px), the last rib wins — reaches the live/streaming tail.
  if (scrollTop + viewportHeight >= contentHeight - 2) return n - 1;
  const anchor = scrollTop + Math.max(0, viewportHeight) * 0.25;
  let active = 0;
  for (let i = 0; i < n; i += 1) {
    if (offsets[i] <= anchor) active = i;
    else break;
  }
  return active;
}
