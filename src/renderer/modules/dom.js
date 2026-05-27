/** Shared DOM references and element factory functions. */

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

export function isNearBottom(el = $("messages")) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD;
}

export function updateScrollToBottomButton() {
  const btn = $("scrollToBottomBtn");
  const messages = $("messages");
  if (!btn || !messages) return;
  btn.hidden = isNearBottom(messages);
}

/** @param {boolean} [force] Scroll even if the user is reading older messages. */
export function scrollToBottom(force = true) {
  const messages = $("messages");
  if (!messages) return;
  if (force || isNearBottom(messages)) {
    messages.scrollTop = messages.scrollHeight;
  }
  updateScrollToBottomButton();
}

export function initScrollToBottom() {
  const messages = $("messages");
  const btn = $("scrollToBottomBtn");
  if (!messages || !btn) return;

  messages.addEventListener(
    "scroll",
    () => updateScrollToBottomButton(),
    { passive: true },
  );

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
