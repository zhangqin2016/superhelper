/**
 * Conversation minimap — DOM layer (Cursor/LibreChat-style right-rail navigator).
 *
 * Derives ribs from the ALREADY-RENDERED chat (no data threading), so it always stays
 * in sync with the transcript. Pure model logic lives in conversation-minimap-model.js
 * (unit-tested). Every entry point is wrapped so any failure removes the rail and the
 * chat degrades to today's plain scroll — never worse (CAPABILITY-GATE Rule 13).
 */

import { t } from "../i18n/index.js";
import { buildMinimapModel, computeActiveIndex } from "./conversation-minimap-model.js";
import { detachAutoFollowForUserNavigation, scrollToBottom } from "./dom.js";

const MIN_RIBS = 4; // below this the rail is noise — hide it
// Dock-style "mountain peak" hover: ticks near the cursor grow — most under it,
// less toward the edges of the radius — a smooth peak rather than one tick popping.
// Both width AND height grow so the hovered tick becomes a comfortably large click
// target even when the ribs are packed tight.
const PEAK_RADIUS = 64; // px around the cursor that bulge
const PEAK_BASE = 18;   // resting tick width (px)
const PEAK_JUT = 42;    // extra px the nearest tick juts outward (width)
const PEAK_H_BASE = 2;  // resting tick height (px)
const PEAK_H_JUT = 8;   // extra px the nearest tick grows (height) → easy to click
const state = new WeakMap(); // panel -> { rail, ribsEl, previewEl, listEl, targets, offsets, raf }

function panelState(panel) {
  let s = state.get(panel);
  if (!s) {
    s = { rail: null, ribsEl: null, previewEl: null, listEl: null, autoFollow: true, targets: [], offsets: [], raf: 0 };
    state.set(panel, s);
  }
  return s;
}

/** Pull a flat item list + DOM scroll targets out of the rendered message list. */
function extractItems(listEl) {
  const items = [];
  const refs = [];
  const articles = listEl.querySelectorAll(":scope > .runtime-user-message, :scope > .assistant-turn-article");
  for (const el of articles) {
    if (el.classList.contains("runtime-user-message")) {
      const body = el.querySelector(".runtime-user-body");
      items.push({ role: "user", label: (body || el).textContent || "" });
      refs.push({ el, headingEls: [] });
      continue;
    }
    // assistant turn — outline from rendered markdown headings (H1–H3)
    const headingEls = Array.from(el.querySelectorAll(".markdown-body h1, .markdown-body h2, .markdown-body h3"));
    const headings = headingEls.map((h) => ({ level: Number(h.tagName.slice(1)) || 1, text: h.textContent || "" }));
    const answer = el.querySelector(".markdown-body");
    items.push({ role: "assistant", label: (answer || el).textContent || "", headings });
    refs.push({ el, headingEls });
  }
  return { items, refs };
}

function targetFor(entry, refs, listEl) {
  if (entry.kind === "terminus") return listEl.lastElementChild || listEl;
  const ref = refs[entry.itemIndex];
  if (!ref) return null;
  if (entry.kind === "heading") return ref.headingEls[entry.headingIndex] || ref.el;
  return ref.el;
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, "\\$&");
}

// Resolve an entry to its rendered DOM node. Data-sourced entries carry a turnId
// (the full history, including not-yet-rendered turns → null until loaded);
// DOM-sourced entries fall back to the extracted refs.
function resolveTarget(entry, refs, listEl) {
  if (entry.kind === "terminus") return listEl.lastElementChild || listEl;
  if (entry.turnId) return listEl.querySelector(`[data-turn-id="${cssEscape(entry.turnId)}"]`) || null;
  if (refs) return targetFor(entry, refs, listEl);
  return null;
}

/** Scroll offset (within the panel's scroll range) at which `el` aligns to the top.
 *  Uses rect math so it is correct regardless of offsetParent nesting. */
function scrollOffsetOf(el, panel) {
  if (!el) return 0;
  return el.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
}

function scrollToTarget(panel, target, terminus) {
  if (terminus || !target) {
    scrollToBottom(true, panel);
    return;
  }
  const top = Math.max(0, scrollOffsetOf(target, panel) - 12);
  detachAutoFollowForUserNavigation(panel);
  panel.scrollTo({ top: Math.min(top, panel.scrollHeight - panel.clientHeight), behavior: "smooth" });
}

function showPreview(s, ribEl, label) {
  if (!s.previewEl) return;
  s.previewEl.textContent = label || "";
  s.previewEl.hidden = !label;
  const railRect = s.rail.getBoundingClientRect();
  const ribRect = ribEl.getBoundingClientRect();
  s.previewEl.style.top = `${ribRect.top - railRect.top}px`;
}

function hidePreview(s) {
  if (s.previewEl) s.previewEl.hidden = true;
}

function ensureRail(panel, s) {
  if (s.rail) return s.rail;
  const rail = document.createElement("aside");
  rail.className = "conversation-minimap";
  rail.setAttribute("aria-label", t("minimap.ariaLabel"));

  const ribsEl = document.createElement("div");
  ribsEl.className = "conversation-minimap-ribs";
  rail.appendChild(ribsEl);

  const previewEl = document.createElement("div");
  previewEl.className = "conversation-minimap-preview";
  previewEl.hidden = true;
  rail.appendChild(previewEl);

  // Drag-scrub: map pointer Y over the ribs column to a scroll fraction.
  const scrub = (clientY) => {
    const rect = ribsEl.getBoundingClientRect();
    if (rect.height <= 0) return;
    const frac = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
    panel.scrollTop = frac * (panel.scrollHeight - panel.clientHeight);
  };
  // A plain click must JUMP to the clicked rib's message (precise), not scrub to a
  // rail fraction — ribs are evenly spaced and centred, so the rail position does
  // NOT match the message's position in the transcript. So: don't scrub on press;
  // only start scrubbing once the pointer actually drags past a threshold, and
  // suppress the trailing click so a drag doesn't also fire a jump.
  const DRAG_THRESHOLD = 5;
  ribsEl.addEventListener("pointerdown", (e) => { s.downY = e.clientY; s.dragging = false; });
  ribsEl.addEventListener("pointermove", (e) => {
    if (s.downY == null) return;
    if (!s.dragging && Math.abs(e.clientY - s.downY) > DRAG_THRESHOLD) {
      s.dragging = true;
      ribsEl.setPointerCapture?.(e.pointerId);
    }
    if (s.dragging) scrub(e.clientY);
  });
  const endDrag = () => { if (s.dragging) s.suppressClick = true; s.dragging = false; s.downY = null; };
  ribsEl.addEventListener("pointerup", endDrag);
  ribsEl.addEventListener("pointercancel", endDrag);
  // Mountain-peak hover + preview of the message under the cursor.
  ribsEl.addEventListener("mousemove", (e) => {
    if (s.peakRaf) return;
    const y = e.clientY;
    s.peakRaf = requestAnimationFrame(() => { s.peakRaf = 0; applyPeak(s, y); });
  });
  ribsEl.addEventListener("mouseleave", () => resetPeak(s));

  // Mount on the panel's parent (the non-scrolling stack), not inside the scroller —
  // an absolutely-positioned child of a scroll container would scroll with content.
  const host = panel.parentElement || panel;
  host.style.position = host.style.position || "relative";
  // Drop any stale rail left by a previous session before adding ours.
  for (const old of host.querySelectorAll(":scope > .conversation-minimap")) old.remove();
  host.appendChild(rail);
  s.rail = rail;
  s.ribsEl = ribsEl;
  s.previewEl = previewEl;
  return rail;
}

function removeHostRails(panel) {
  const host = panel?.parentElement || panel;
  if (!host?.querySelectorAll) return;
  for (const old of host.querySelectorAll(":scope > .conversation-minimap")) old.remove();
}

// Keep the active rib visible inside the scrollable ribs column — scrolls ONLY
// the ribs container (never an ancestor / the transcript).
function keepActiveInView(s, idx) {
  const ribsEl = s.ribsEl;
  const rib = s.ribs && s.ribs[idx];
  if (!ribsEl || !rib || ribsEl.scrollHeight <= ribsEl.clientHeight) return;
  const top = rib.offsetTop;
  const bottom = top + rib.offsetHeight;
  if (top < ribsEl.scrollTop) ribsEl.scrollTop = Math.max(0, top - 8);
  else if (bottom > ribsEl.scrollTop + ribsEl.clientHeight) ribsEl.scrollTop = bottom - ribsEl.clientHeight + 8;
}

function refreshActive(panel, s) {
  const idx = computeActiveIndex(panel.scrollTop, panel.clientHeight, panel.scrollHeight, s.offsets);
  const ribs = s.ribsEl ? s.ribsEl.children : [];
  for (let i = 0; i < ribs.length; i += 1) ribs[i].classList.toggle("is-active", i === idx);
  if (!s.dragging) keepActiveInView(s, idx); // don't move ribs under the cursor mid-drag
}

/** Dock-style fisheye: widen ticks by proximity to the cursor into a smooth peak, and
 *  preview the message under the cursor. Centers are precomputed in updateMinimap. */
function applyPeak(s, clientY) {
  if (s.dragging || !s.ribsEl || !s.ribs || !s.ribs.length) return;
  const rect = s.ribsEl.getBoundingClientRect();
  const y = clientY - rect.top;
  const scrollTop = s.ribsEl.scrollTop || 0; // ribs column may be scrolled (many ribs)
  let nearest = -1;
  let nearestDist = Infinity;
  for (let i = 0; i < s.ribs.length; i += 1) {
    const d = Math.abs((s.ribCenters[i] || 0) - scrollTop - y);
    const e = Math.max(0, 1 - d / PEAK_RADIUS) ** 2; // squared falloff -> smooth peak
    s.ribs[i].style.setProperty("--rib-w", `${PEAK_BASE + PEAK_JUT * e}px`);
    s.ribs[i].style.setProperty("--rib-h", `${PEAK_H_BASE + PEAK_H_JUT * e}px`);
    if (d < nearestDist) { nearestDist = d; nearest = i; }
  }
  if (nearest >= 0) showPreview(s, s.ribs[nearest], s.labels[nearest]);
}

function resetPeak(s) {
  if (s.ribs) for (const r of s.ribs) {
    r.style.removeProperty("--rib-w");
    r.style.removeProperty("--rib-h");
  }
  hidePreview(s);
}

function bindScroll(panel, s) {
  if (s.scrollBound) return;
  s.scrollBound = true;
  panel.addEventListener("scroll", () => {
    if (!s.autoFollow || !s.rail) return;
    if (s.raf) return;
    s.raf = requestAnimationFrame(() => { s.raf = 0; refreshActive(panel, s); });
  }, { passive: true });
}

/** Rebuild the rail for a panel. Safe to call on every render; cheap and idempotent. */
export function updateMinimap(panel, opts = {}) {
  if (!panel || typeof document === "undefined") return;
  let s;
  try {
    s = panelState(panel);
    const listEl = panel.querySelector(".messages");
    if (!listEl) { teardownMinimap(panel); removeHostRails(panel); return; }
    s.listEl = listEl;

    // Data-sourced items (full conversation, incl. not-yet-rendered turns) when
    // the caller provides them; otherwise derive from the rendered DOM (fallback,
    // keeps the rail working even without the data wiring). jumpToTurn (from the
    // caller) loads older history on demand before scrolling.
    const provided = Array.isArray(opts.items) && opts.items.length > 0;
    const jumpToTurn = typeof opts.jumpToTurn === "function" ? opts.jumpToTurn : null;
    const { items, refs } = provided ? { items: opts.items, refs: null } : extractItems(listEl);
    // ONE tick per question only — answers get no ticks (scope "prompts"). The rail is
    // a clean list of the user's questions to jump between; hovering a tick previews
    // that question. Keeps it sparse and meaningful instead of a dense striped block.
    const entries = buildMinimapModel(items, {
      scope: "prompts",
      terminus: true,
      terminusLabel: t("minimap.jumpLatest"),
    });

    if (entries.length < MIN_RIBS) { teardownMinimap(panel); removeHostRails(panel); return; }

    ensureRail(panel, s);
    bindScroll(panel, s);

    s.ribsEl.replaceChildren();
    s.targets = [];
    s.offsets = [];
    s.ribs = [];
    s.labels = [];
    const contentHeight = Math.max(1, panel.scrollHeight);
    entries.forEach((entry) => {
      const rib = document.createElement("button");
      rib.type = "button";
      rib.className = `conversation-minimap-rib is-${entry.kind}${entry.kind === "heading" ? ` is-h${entry.level}` : ""}`;
      rib.setAttribute("aria-label", entry.label || entry.kind);
      const target = resolveTarget(entry, refs, listEl);
      const isTerminus = entry.kind === "terminus";
      // Ticks flow in a flex column with a FIXED gap, vertically centred (see CSS) —
      // tight together in the middle rather than stretched to fill the rail height.
      rib.addEventListener("click", () => {
        if (s.suppressClick) { s.suppressClick = false; return; } // ignore the click that ends a drag
        if (isTerminus) { scrollToTarget(panel, null, true); return; }
        // Data-sourced ribs may already be rendered in the current window. Use
        // the explicit local panel scroll first; only ask the caller to load
        // older history when the target is not mounted yet.
        if (target) { scrollToTarget(panel, target, false); return; }
        if (entry.turnId && jumpToTurn) jumpToTurn(entry.turnId);
        else scrollToTarget(panel, target, false);
      });
      s.ribsEl.appendChild(rib);
      s.ribs.push(rib);
      s.labels.push(entry.label || "");
      s.targets.push(target);
      s.offsets.push(isTerminus ? contentHeight : scrollOffsetOf(target, panel));
    });
    // Precompute each tick's vertical centre (px within the ribs column) for the
    // proximity-based peak — read once here, not per mousemove.
    s.ribCenters = s.ribs.map((r) => r.offsetTop + r.offsetHeight / 2);
    refreshActive(panel, s);
  } catch {
    // Any failure -> remove the rail; the chat keeps working without a minimap.
    try { teardownMinimap(panel); } catch { /* ignore */ }
  }
}

export function teardownMinimap(panel) {
  const s = state.get(panel);
  if (s?.rail?.parentElement) s.rail.parentElement.removeChild(s.rail);
  if (s) { s.rail = null; s.ribsEl = null; s.previewEl = null; }
}
