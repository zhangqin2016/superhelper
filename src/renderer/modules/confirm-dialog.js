/**
 * Small in-app confirmation dialog.
 */

import { t } from "../i18n/index.js";

let activeDialog = null;

export function confirmDialog({
  title = t("confirm.defaultTitle"),
  message = "",
  confirmText = t("prompt.confirm"),
  cancelText = t("prompt.cancel"),
  danger = false,
} = {}) {
  if (activeDialog) {
    activeDialog.remove();
    activeDialog = null;
  }

  return new Promise((resolve) => {
    const overlay = document.createElement("section");
    overlay.className = "modal-panel name-prompt-panel";
    overlay.innerHTML = `
      <div class="modal-card name-prompt-card">
        <header class="modal-header">
          <div>
            <h2 class="name-prompt-title"></h2>
            <p class="name-prompt-label"></p>
          </div>
        </header>
        <div class="name-prompt-actions">
          <button type="button" class="topbar-btn confirm-dialog-cancel"></button>
          <button type="button" class="send-btn confirm-dialog-confirm"></button>
        </div>
      </div>
    `;

    overlay.querySelector(".name-prompt-title").textContent = title;
    overlay.querySelector(".name-prompt-label").textContent = message;
    overlay.querySelector(".confirm-dialog-cancel").textContent = cancelText;
    const confirmBtn = overlay.querySelector(".confirm-dialog-confirm");
    confirmBtn.textContent = confirmText;
    confirmBtn.classList.toggle("confirm-dialog-danger", Boolean(danger));

    const finish = (value) => {
      overlay.remove();
      activeDialog = null;
      document.removeEventListener("keydown", onKeyDown);
      resolve(value);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") finish(false);
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      }
    };

    overlay.querySelector(".confirm-dialog-cancel").addEventListener("click", () => finish(false));
    confirmBtn.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(false);
    });

    document.body.appendChild(overlay);
    activeDialog = overlay;
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => confirmBtn.focus());
  });
}
