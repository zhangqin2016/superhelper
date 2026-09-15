/**
 * The prompt-suggestion bar under the composer. Extracted from composer.js
 * (architecture ratchet): a self-contained view over the same DOM node, driven
 * by the composer's `canSend` predicate.
 */

import store from "./state.js";
import { $ } from "./dom.js";
import { canSend } from "./session-runtime-store.js";

export function renderPromptSuggestions(sessionId, suggestions = []) {
  const bar = $("promptSuggestions");
  if (!bar) return;
  const activeId = store.get("activeSessionId");
  if (sessionId !== activeId || !canSend(sessionId)) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }

  const items = (suggestions || [])
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item.prompt === "string") return item.prompt.trim();
      if (item && typeof item.text === "string") return item.text.trim();
      return "";
    })
    .filter(Boolean)
    .slice(0, 4);

  if (!items.length) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }

  bar.hidden = false;
  bar.replaceChildren();
  for (const text of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "prompt-suggestion-btn";
    btn.textContent = text.length > 80 ? `${text.slice(0, 77)}…` : text;
    btn.title = text;
    btn.addEventListener("click", () => {
      const input = $("promptInput");
      if (input) input.value = text;
      bar.hidden = true;
      bar.replaceChildren();
      input?.focus();
    });
    bar.appendChild(btn);
  }
}

export function clearPromptSuggestions() {
  renderPromptSuggestions(store.get("activeSessionId"), []);
}
