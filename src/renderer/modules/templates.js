/**
 * Quick command templates panel (left panel).
 */

import store from "./state.js";
import { $ } from "./dom.js";

const container = () => $("templateList");

export async function loadTemplates() {
  const result = await window.assistantClient.listTemplates();
  if (result.ok) {
    store.set("templates", result.templates);
    renderTemplates();
  }
}

export function renderTemplates() {
  const el = container();
  if (!el) return;
  el.textContent = "";

  const templates = store.get("templates") || [];
  for (const t of templates) {
    const btn = document.createElement("button");
    btn.className = "template-item";
    btn.textContent = t.title;
    btn.title = t.prompt;
    btn.addEventListener("click", () => {
      const input = $("promptInput");
      if (input) {
        input.value = t.prompt;
        input.focus();
      }
    });
    el.appendChild(btn);
  }
}
