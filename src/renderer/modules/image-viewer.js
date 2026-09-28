/**
 * Image preview: in the right-hand preview pane when this window has one,
 * otherwise (or with `modal: true`) the full-screen modal.
 */

import { t } from "../i18n/index.js";
import { tryOpenInPreviewPane } from "./preview-pane.js";

const APP_FILE_PREFIX = "app-file://media/";

function localPathFromSource(src = "") {
  const value = String(src || "");
  if (!value.startsWith(APP_FILE_PREFIX)) return "";
  try { return decodeURIComponent(value.slice(APP_FILE_PREFIX.length).split(/[?#]/)[0]); } catch { return ""; }
}

/**
 * Open an image preview.
 * @param {string} src   Image URL (data URL or path).
 * @param {string} alt   Alt text for the image.
 * @param {{modal?: boolean}} [options]  modal: always the full-screen view.
 */
export function openImageViewer(src, alt, { modal = false } = {}) {
  if (!src) return;
  if (!modal && tryOpenInPreviewPane({ kind: "image", src, path: localPathFromSource(src), title: alt || localPathFromSource(src) })) return;
  const overlay = document.createElement("div");
  overlay.className = "image-viewer";

  const bg = document.createElement("div");
  bg.className = "image-viewer-bg";

  const img = document.createElement("img");
  img.className = "image-viewer-img";
  img.src = src;
  img.alt = alt || "";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "image-viewer-close";
  closeBtn.innerHTML = "&times;";
  closeBtn.setAttribute("aria-label", t("composer.close"));

  overlay.append(bg, img, closeBtn);

  function dismiss() {
    overlay.classList.add("image-viewer-closing");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
    setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 300);
    document.removeEventListener("keydown", onKey);
  }

  function onKey(e) {
    if (e.key === "Escape") dismiss();
  }

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target === bg || e.target.closest(".image-viewer-close")) {
      dismiss();
    }
  });

  img.addEventListener("click", (e) => e.stopPropagation());

  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => overlay.classList.add("image-viewer-open"));
}
