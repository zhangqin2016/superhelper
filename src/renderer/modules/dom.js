/** Shared DOM references and element factory functions. */

import store from "./state.js";
import {
  nextAutoFollowDetachedState,
  shouldRunScheduledAutoFollow,
} from "./scroll-geometry.js";

export const $ = (id) => document.getElementById(id);

const SCROLL_THRESHOLD = 72;
const USER_SCROLL_DETACHED = "userScrollDetached";
const USER_SCROLL_INTENT_UNTIL = "userScrollIntentUntil";
const USER_SCROLL_UP_INTENT_UNTIL = "userScrollUpIntentUntil";
const USER_SCROLL_NAVIGATION_VERSION = "userScrollNavigationVersion";
const PROGRAMMATIC_SCROLL = "programmaticScroll";
const scheduledAutoFollowVersions = new WeakMap();

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

export function detachAutoFollowForUserNavigation(panel) {
  if (!panel?.dataset) return;
  markUserScrollIntent(panel);
  setUserScrollDetached(panel, true);
  panel.dataset.lastScrollTop = String(panel.scrollTop || 0);
  updateScrollToBottomButton(panel);
}

function markProgrammaticScroll(panel) {
  if (!panel?.dataset) return;
  delete panel.dataset[USER_SCROLL_INTENT_UNTIL];
  delete panel.dataset[USER_SCROLL_UP_INTENT_UNTIL];
  panel.dataset[PROGRAMMATIC_SCROLL] = "1";
  requestAnimationFrame(() => {
    if (panel.dataset[PROGRAMMATIC_SCROLL] === "1") delete panel.dataset[PROGRAMMATIC_SCROLL];
  });
}

function markUserScrollIntent(panel) {
  if (!panel?.dataset) return;
  delete panel.dataset[PROGRAMMATIC_SCROLL];
  panel.dataset[USER_SCROLL_INTENT_UNTIL] = String(Date.now() + 1000);
  panel.dataset[USER_SCROLL_NAVIGATION_VERSION] = String(
    Number(panel.dataset[USER_SCROLL_NAVIGATION_VERSION] || 0) + 1,
  );
}

function userScrollNavigationVersion(panel) {
  return Number(panel?.dataset?.[USER_SCROLL_NAVIGATION_VERSION] || 0);
}

function hasUserScrollIntent(panel) {
  return Number(panel?.dataset?.[USER_SCROLL_INTENT_UNTIL] || 0) > Date.now();
}

function markUpwardUserScrollIntent(panel) {
  if (!panel?.dataset) return;
  panel.dataset[USER_SCROLL_UP_INTENT_UNTIL] = String(Date.now() + 1000);
}

function clearUpwardUserScrollIntent(panel) {
  if (!panel?.dataset) return;
  delete panel.dataset[USER_SCROLL_UP_INTENT_UNTIL];
}

function hasUpwardUserScrollIntent(panel) {
  return Number(panel?.dataset?.[USER_SCROLL_UP_INTENT_UNTIL] || 0) > Date.now();
}

export function updateScrollToBottomButton(scrollEl) {
  const btn = $("scrollToBottomBtn");
  const messages = scrollEl || getActiveMessagesEl();
  if (!btn || !messages) return;
  btn.hidden = !isUserScrollDetached(messages) && isNearBottom(messages);
}

/** Scroll after layout/markdown rendering has settled. */
export function scrollToBottomAfterLayout(scrollEl, force = false) {
  const panel = scrollEl || getActiveMessagesEl();
  if (!panel) return;
  const scheduledNavigationVersion = userScrollNavigationVersion(panel);
  const detachedAtSchedule = isUserScrollDetached(panel);
  const scheduleVersion = Number(scheduledAutoFollowVersions.get(panel) || 0) + 1;
  scheduledAutoFollowVersions.set(panel, scheduleVersion);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (scheduledAutoFollowVersions.get(panel) !== scheduleVersion) return;
      scheduledAutoFollowVersions.delete(panel);
      if (!shouldRunScheduledAutoFollow({
        scheduledNavigationVersion,
        currentNavigationVersion: userScrollNavigationVersion(panel),
        hasUserScrollIntent: hasUserScrollIntent(panel),
        detachedAtSchedule,
        detachedNow: isUserScrollDetached(panel),
      })) {
        updateScrollToBottomButton(panel);
        return;
      }
      scrollToBottom(force, panel);
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
  panel.addEventListener("wheel", (event) => {
    markUserScrollIntent(panel);
    if (!event.ctrlKey && Number(event.deltaY || 0) < 0) {
      markUpwardUserScrollIntent(panel);
      setUserScrollDetached(panel, true);
    } else {
      clearUpwardUserScrollIntent(panel);
    }
  }, { passive: true });
  let lastTouchY = null;
  panel.addEventListener("touchstart", (event) => {
    markIntent();
    lastTouchY = Number(event.touches?.[0]?.clientY);
  }, { passive: true });
  panel.addEventListener("touchmove", (event) => {
    const touchY = Number(event.touches?.[0]?.clientY);
    if (Number.isFinite(lastTouchY) && Number.isFinite(touchY) && touchY > lastTouchY + 1) {
      markUserScrollIntent(panel);
      markUpwardUserScrollIntent(panel);
      setUserScrollDetached(panel, true);
    } else if (Number.isFinite(lastTouchY) && Number.isFinite(touchY) && touchY < lastTouchY - 1) {
      clearUpwardUserScrollIntent(panel);
    }
    lastTouchY = touchY;
  }, { passive: true });
  panel.addEventListener("touchend", () => {
    lastTouchY = null;
  }, { passive: true });
  panel.addEventListener("touchcancel", () => {
    lastTouchY = null;
  }, { passive: true });
  panel.addEventListener("pointerdown", markIntent, { passive: true });
  panel.addEventListener(
    "scroll",
    () => {
      if (!panel.classList.contains("is-active")) return;
      const previousTop = Number(panel.dataset.lastScrollTop || 0);
      const currentTop = Number(panel.scrollTop || 0);
      const userScrolledUp = currentTop < previousTop - 1;
      const nearBottom = isNearBottom(panel);
      const hasUserScrollIntentNow = hasUserScrollIntent(panel);
      const upwardUserScrollIntent = hasUpwardUserScrollIntent(panel);
      const programmaticScroll = panel.dataset[PROGRAMMATIC_SCROLL] === "1";
      const wasDetached = isUserScrollDetached(panel);
      const nextDetached = nextAutoFollowDetachedState({
        previousDetached: wasDetached,
        hasUserScrollIntent: hasUserScrollIntentNow,
        upwardUserScrollIntent,
        programmaticScroll,
        userScrolledUp,
        nearBottom,
      });
      setUserScrollDetached(panel, nextDetached);
      if (upwardUserScrollIntent && userScrolledUp) clearUpwardUserScrollIntent(panel);
      if (hasUserScrollIntentNow) delete panel.dataset[USER_SCROLL_INTENT_UNTIL];
      if (!nextDetached && !nearBottom && !hasUserScrollIntentNow && !programmaticScroll) {
        scrollToBottomAfterLayout(panel, true);
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
