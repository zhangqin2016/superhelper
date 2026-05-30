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

function remove(el) {
  el.classList.remove("toast-visible");
  el.addEventListener("transitionend", () => el.remove(), { once: true });
  setTimeout(() => { if (el.parentNode) el.remove(); }, 350);
}
