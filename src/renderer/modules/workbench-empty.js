/**
 * Center panel empty state — task-oriented onboarding for new/empty chats.
 */

import { $ } from "./dom.js";
import { t } from "../i18n/index.js";

export const WORKBENCH_EXAMPLE_KEYS = [
  "workbench.example1",
  "workbench.example2",
  "workbench.example3",
];

/** @param {HTMLElement | null | undefined} listEl */
export function listHasWorkbenchContent(listEl) {
  if (!listEl) return false;
  return [...listEl.children].some((el) => !el.classList.contains("workbench-empty"));
}

export function buildWorkbenchEmpty() {
  const root = document.createElement("div");
  root.className = "workbench-empty";

  const icon = document.createElement("div");
  icon.className = "workbench-empty-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "◇";

  const title = document.createElement("h2");
  title.className = "workbench-empty-title";
  title.textContent = t("workbench.emptyTitle");

  const lead = document.createElement("p");
  lead.className = "workbench-empty-lead";
  lead.textContent = t("workbench.emptyLead");

  const examples = document.createElement("div");
  examples.className = "workbench-empty-examples";

  for (const key of WORKBENCH_EXAMPLE_KEYS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "workbench-empty-example";
    btn.textContent = t(key);
    btn.addEventListener("click", () => {
      const input = $("promptInput");
      if (!input) return;
      input.value = t(key);
      input.focus();
    });
    examples.append(btn);
  }

  const hint = document.createElement("p");
  hint.className = "workbench-empty-hint";
  hint.textContent = t("workbench.emptyHint");

  root.append(icon, title, lead, examples, hint);
  return root;
}

/** @param {HTMLElement | null | undefined} listEl */
export function syncWorkbenchEmptyState(listEl) {
  if (!listEl) return;
  const hasContent = listHasWorkbenchContent(listEl);
  let empty = listEl.querySelector(".workbench-empty");

  if (hasContent) {
    empty?.remove();
    return;
  }

  if (!empty) {
    empty = buildWorkbenchEmpty();
    listEl.appendChild(empty);
  }
}
