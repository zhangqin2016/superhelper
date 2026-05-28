/** Shared DOM references and element factory functions. */

import store from "./state.js";

export const $ = (id) => document.getElementById(id);

const SCROLL_THRESHOLD = 72;

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

export function updateScrollToBottomButton(scrollEl) {
  const btn = $("scrollToBottomBtn");
  const messages = scrollEl || getActiveMessagesEl();
  if (!btn || !messages) return;
  btn.hidden = isNearBottom(messages);
}

/** Scroll after layout/markdown rendering has settled. */
export function scrollToBottomAfterLayout(scrollEl) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scrollToBottom(true, scrollEl);
    });
  });
}

/** @param {boolean} [force] Scroll even if the user is reading older messages. */
export function scrollToBottom(force = true, scrollEl) {
  const messages = scrollEl || getActiveMessagesEl();
  if (!messages) return;
  if (force || isNearBottom(messages)) {
    messages.scrollTop = messages.scrollHeight;
  }
  updateScrollToBottomButton(messages);
}

export function bindPanelScroll(panel) {
  if (!panel || panel.dataset.scrollBound === "1") return;
  panel.dataset.scrollBound = "1";
  panel.addEventListener(
    "scroll",
    () => {
      if (panel.classList.contains("is-active")) {
        updateScrollToBottomButton(panel);
      }
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
