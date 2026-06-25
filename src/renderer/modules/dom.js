/** Shared DOM references and element factory functions. */

import store from "./state.js";

export const $ = (id) => document.getElementById(id);

const SCROLL_THRESHOLD = 72;
const USER_SCROLL_DETACHED = "userScrollDetached";
const USER_SCROLL_INTENT_UNTIL = "userScrollIntentUntil";
const PROGRAMMATIC_SCROLL = "programmaticScroll";

export function el(tag, className, attrs = {}) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "textContent") e.textContent = v;
    else if (k === "innerHTML") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "title") e.title = v;
    else e.setAttribute(k, v);
  }
  return e;
}

export function getActiveMessagesEl() {
  const sid = store.get("activeSessionId");
  if (sid) {
    const panel = document.querySelector(`.session-messages[data-session-id="${sid}"]`);
    if (panel) return panel;
  }
  return document.querySelector(".session-messages.is-active");
}

export function isNearBottom(el) {
  const scrollEl = el || getActiveMessagesEl();
  if (!scrollEl) return true;
  return scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= SCROLL_THRESHOLD;
}

export function isUserScrollDetached(el) {
  const scrollEl = el || getActiveMessagesEl();
  return scrollEl?.dataset?.[USER_SCROLL_DETACHED] === "1";
}

function setUserScrollDetached(panel, detached) {
  if (!panel?.dataset) return;
  if (detached) panel.dataset[USER_SCROLL_DETACHED] = "1";
  else delete panel.dataset[USER_SCROLL_DETACHED];
}

function markProgrammaticScroll(panel) {
  if (!panel?.dataset) return;
  panel.dataset[PROGRAMMATIC_SCROLL] = "1";
  requestAnimationFrame(() => {
    if (panel.dataset[PROGRAMMATIC_SCROLL] === "1") delete panel.dataset[PROGRAMMATIC_SCROLL];
  });
}

function markUserScrollIntent(panel) {
  if (!panel?.dataset) return;
  delete panel.dataset[PROGRAMMATIC_SCROLL];
  panel.dataset[USER_SCROLL_INTENT_UNTIL] = String(Date.now() + 1000);
}

export function updateScrollToBottomButton(scrollEl) {
  const btn = $("scrollToBottomBtn");
  const messages = scrollEl || getActiveMessagesEl();
  if (!btn || !messages) return;
  btn.hidden = isNearBottom(messages);
}

/** Scroll after layout/markdown rendering has settled. */
export function scrollToBottomAfterLayout(scrollEl, force = false) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scrollToBottom(force, scrollEl);
    });
  });
}

/** @param {boolean} [force] Scroll even if the user is reading older messages. */
export function scrollToBottom(force = true, scrollEl) {
  const messages = scrollEl || getActiveMessagesEl();
  if (!messages) return;
  if (force || isNearBottom(messages)) {
    setUserScrollDetached(messages, false);
    markProgrammaticScroll(messages);
    messages.scrollTop = messages.scrollHeight;
    if (messages.dataset) messages.dataset.lastScrollTop = String(messages.scrollTop || 0);
  }
  updateScrollToBottomButton(messages);
}

/** Throttled variant — at most one scroll per animation frame. */
let _scrollThrottle = null;
export function scrollToBottomThrottled(force = false, scrollEl) {
  if (_scrollThrottle) return;
  _scrollThrottle = requestAnimationFrame(() => {
    _scrollThrottle = null;
    scrollToBottom(force, scrollEl);
  });
}

export function bindPanelScroll(panel) {
  if (!panel || panel.dataset.scrollBound === "1") return;
  panel.dataset.scrollBound = "1";
  panel.dataset.lastScrollTop = String(panel.scrollTop || 0);
  const markIntent = () => markUserScrollIntent(panel);
  panel.addEventListener("wheel", markIntent, { passive: true });
  panel.addEventListener("touchstart", markIntent, { passive: true });
  panel.addEventListener("pointerdown", markIntent, { passive: true });
  panel.addEventListener(
    "scroll",
    () => {
      if (!panel.classList.contains("is-active")) return;
      const previousTop = Number(panel.dataset.lastScrollTop || 0);
      const currentTop = Number(panel.scrollTop || 0);
      const userScrolledUp = currentTop < previousTop - 1;
      const nearBottom = isNearBottom(panel);
      const hasUserScrollIntent = Number(panel.dataset[USER_SCROLL_INTENT_UNTIL] || 0) > Date.now();
      if (hasUserScrollIntent || panel.dataset[PROGRAMMATIC_SCROLL] !== "1") {
        setUserScrollDetached(panel, userScrolledUp || !nearBottom);
        delete panel.dataset[USER_SCROLL_INTENT_UNTIL];
      } else if (nearBottom) {
        setUserScrollDetached(panel, false);
      }
      panel.dataset.lastScrollTop = String(currentTop);
      updateScrollToBottomButton(panel);
    },
    { passive: true },
  );
}

export function initScrollToBottom() {
  const btn = $("scrollToBottomBtn");
  if (!btn) return;

  btn.addEventListener("click", () => {
    scrollToBottom(true);
  });

  updateScrollToBottomButton();
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
