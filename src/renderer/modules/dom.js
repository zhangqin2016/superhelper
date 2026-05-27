/** Shared DOM references and element factory functions. */

export const $ = (id) => document.getElementById(id);

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

export function scrollToBottom() {
  const messages = $("messages");
  if (messages) messages.scrollTop = messages.scrollHeight;
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
