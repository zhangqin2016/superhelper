/**
 * The restart countdown of a mandatory update.
 *
 * The main process owns the mandate and its deadline (update-manager
 * driveEnforcement): this only shows it. It appears when a countdown is running
 * — which the main process starts only once the update is downloaded and no
 * task is running — and it cannot be dismissed, because dismissing would not
 * stop the restart. It offers exactly what the delivered policy allows:
 * restart now, or "later" while deferrals remain.
 */

import { t } from "../i18n/index.js";
import { showToast } from "./toast.js";

let panel = null;
let ticker = null;
let shownFor = "";

function secondsLeft(installAt) {
  return Math.max(0, Math.ceil((Number(installAt) - Date.now()) / 1000));
}

function close() {
  if (ticker) clearInterval(ticker);
  ticker = null;
  panel?.remove();
  panel = null;
  shownFor = "";
}

function reasonText(enforcement) {
  const reasons = enforcement.reasons || [];
  if (reasons.includes("release") && reasons.includes("policy")) return t("update.mandate.reasonBoth");
  if (reasons.includes("policy")) return t("update.mandate.reasonPolicy");
  return t("update.mandate.reasonRelease");
}

function open(state) {
  const enforcement = state.enforcement;
  panel = document.createElement("section");
  panel.className = "modal-panel name-prompt-panel update-mandate-panel";
  panel.setAttribute("role", "alertdialog");
  panel.setAttribute("aria-modal", "true");
  panel.innerHTML = `
    <div class="modal-card name-prompt-card">
      <header class="modal-header">
        <div>
          <h2 class="name-prompt-title"></h2>
          <p class="name-prompt-label update-mandate-reason"></p>
          <p class="name-prompt-label update-mandate-countdown" aria-live="polite"></p>
        </div>
      </header>
      <div class="name-prompt-actions">
        <button type="button" class="dialog-btn update-mandate-later"></button>
        <button type="button" class="dialog-btn dialog-btn--primary update-mandate-now"></button>
      </div>
    </div>`;
  panel.querySelector(".name-prompt-title").textContent = t("update.mandate.title", { version: state.latestVersion || enforcement.requiredVersion });
  panel.querySelector(".update-mandate-reason").textContent = reasonText(enforcement);
  const later = panel.querySelector(".update-mandate-later");
  if (enforcement.canDefer) {
    later.textContent = t("update.mandate.later", { minutes: enforcement.deferMinutes, left: enforcement.deferralsLeft });
    later.addEventListener("click", async () => {
      later.disabled = true;
      const result = await window.assistantClient.deferUpdate?.();
      if (result?.ok === false) {
        later.disabled = false;
        showToast(t(`update.error.${result.error?.code || "GENERIC"}`), "error");
      }
    });
  } else {
    later.hidden = true;
  }
  const now = panel.querySelector(".update-mandate-now");
  now.textContent = t("update.mandate.now");
  now.addEventListener("click", async () => {
    now.disabled = true;
    const result = await window.assistantClient.installUpdate({ force: false });
    if (result?.ok === false) now.disabled = false;
  });
  const countdown = panel.querySelector(".update-mandate-countdown");
  const paint = () => {
    countdown.textContent = t("update.mandate.countdown", { seconds: secondsLeft(enforcement.installAt) });
  };
  paint();
  ticker = setInterval(paint, 1000);
  document.body.appendChild(panel);
  requestAnimationFrame(() => now.focus());
}

/** Reflect the main process's mandate: open while a countdown runs, close otherwise. */
export function renderUpdateMandate(state) {
  const enforcement = state?.enforcement;
  const key = enforcement?.required && enforcement.installAt ? `${enforcement.requiredVersion}@${enforcement.installAt}` : "";
  if (!key) {
    if (panel) close();
    return;
  }
  if (key === shownFor) return;
  close();
  shownFor = key;
  open(state);
}
