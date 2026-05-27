/**
 * Full-screen image preview modal.
 */

/**
 * Open a full-screen image preview.
 * @param {string} src   Image URL (data URL or path).
 * @param {string} alt   Alt text for the image.
 */
export function openImageViewer(src, alt) {
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
  closeBtn.setAttribute("aria-label", "关闭");

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
