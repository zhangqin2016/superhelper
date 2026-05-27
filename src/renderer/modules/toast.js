/**
 * Toast notification system.
 * Renders stacked notifications at the top-right of the app.
 */

const TYPES = ["error", "warning", "info", "success"];
let container = null;

function ensureContainer() {
  if (container) return container;
  container = document.createElement("div");
  container.className = "toast-container";
  container.id = "toastContainer";
  document.body.appendChild(container);
  return container;
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {"error"|"warning"|"info"|"success"} type
 * @param {number} duration  Auto-dismiss after ms (0 = persistent).
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

  // Animate in
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

export const FILE_ERROR_MESSAGES = {
  FILE_NOT_FOUND: "文件不存在或路径无效。",
  NOT_A_FILE: "暂不支持上传文件夹。",
  UNSUPPORTED_TYPE: "不支持此文件格式。支持的格式：图片(png/jpg/gif/webp/svg/bmp)、文档(pdf/doc/txt/md/csv)、代码文件。",
  FILE_TOO_LARGE: "文件超过 20MB 限制，请压缩后重试。",
};

export function fileErrorMessage(error, fileName) {
  const base = FILE_ERROR_MESSAGES[error] || `文件处理失败：${error}`;
  return fileName ? `${base}（${fileName}）` : base;
}
