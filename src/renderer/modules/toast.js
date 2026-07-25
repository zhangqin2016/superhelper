/**
 * Toast notification system.
 */

export { fileErrorMessage } from "../i18n/index.js";

let container = null;

function ensureContainer() {
  if (container) return container;
  container = document.getElementById("toastContainer");
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    container.id = "toastContainer";
    document.body.appendChild(container);
  }
  return container;
}

/**
 * @param {string} message
 * @param {"error"|"warning"|"info"|"success"} type
 * @param {number} duration
 */
export function showToast(message, type = "error", duration = 5000) {
  const ct = ensureContainer();

  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.setAttribute("role", "alert");

  const icon = { error: "✕", warning: "⚠", info: "ℹ", success: "✓" }[type] || "";
  el.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-msg">${message}</span>`;

  el.addEventListener("click", () => remove(el));

  ct.appendChild(el);

  requestAnimationFrame(() => el.classList.add("toast-visible"));

  if (duration > 0) {
    setTimeout(() => remove(el), duration);
  }

  return el;
}

/**
 * Action contract: thrown/rejected actions and `{ ok: false }` results keep the
 * toast open in a retryable failed state. Any other result counts as success.
 * Callers remain responsible for presenting a localized error message.
 */
export function showActionToast(message, actionLabel, onAction, type = "success", duration = 5000) {
  const el = showToast(message, type, 0);
  const action = document.createElement("button");
  const parsedDuration = Number(duration);
  let remaining = Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : 0;
  let timerId = null;
  let startedAt = 0;
  let pointerInside = false;
  let focusInside = false;
  let actionPending = false;

  function clearActionTimer() {
    if (timerId === null) return;
    clearTimeout(timerId);
    timerId = null;
  }

  function pauseCountdown() {
    if (timerId === null) return;
    remaining = Math.max(0, remaining - (Date.now() - startedAt));
    clearActionTimer();
  }

  function resumeCountdown() {
    if (
      remaining <= 0
      || timerId !== null
      || pointerInside
      || focusInside
      || actionPending
      || el.dataset.toastRemoving === "true"
    ) {
      return;
    }
    startedAt = Date.now();
    timerId = setTimeout(() => {
      timerId = null;
      remaining = 0;
      remove(el);
    }, remaining);
  }

  function markActionFailed(error) {
    console.error("[toast] action failed:", error);
    actionPending = false;
    action.disabled = false;
    action.setAttribute("aria-busy", "false");
    action.setAttribute("aria-invalid", "true");
    el.dataset.actionState = "failed";
    resumeCountdown();
  }

  action.type = "button";
  action.className = "toast-action";
  action.textContent = actionLabel;
  action.setAttribute("aria-busy", "false");
  el.dataset.actionState = "idle";
  action.addEventListener("click", (event) => {
    event.stopPropagation();
    if (action.disabled) return;

    action.disabled = true;
    actionPending = true;
    action.setAttribute("aria-busy", "true");
    action.removeAttribute("aria-invalid");
    el.dataset.actionState = "pending";
    pauseCountdown();

    Promise.resolve()
      .then(() => onAction?.())
      .then((result) => {
        if (result?.ok === false) {
          const error = new Error(String(result.error || "ACTION_FAILED"));
          error.result = result;
          throw error;
        }
        actionPending = false;
        clearActionTimer();
        el.dataset.actionState = "succeeded";
        remove(el);
      })
      .catch((error) => {
        markActionFailed(error);
      });
  });

  el.addEventListener("pointerenter", () => {
    pointerInside = true;
    pauseCountdown();
  });
  el.addEventListener("pointerleave", () => {
    pointerInside = false;
    resumeCountdown();
  });
  el.addEventListener("focusin", () => {
    focusInside = true;
    pauseCountdown();
  });
  el.addEventListener("focusout", (event) => {
    if (event.relatedTarget && el.contains(event.relatedTarget)) return;
    focusInside = false;
    resumeCountdown();
  });
  el.addEventListener("click", clearActionTimer);

  el.appendChild(action);
  resumeCountdown();
  return el;
}

function remove(el) {
  if (!el || el.dataset.toastRemoving === "true") return;
  el.dataset.toastRemoving = "true";
  el.classList.remove("toast-visible");
  el.addEventListener("transitionend", () => el.remove(), { once: true });
  setTimeout(() => { if (el.parentNode) el.remove(); }, 350);
}
