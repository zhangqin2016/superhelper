/**
 * File attachment handling: drag-drop, paste, file picker, preview chips.
 */

import store from "./state.js";
import { $, el, formatFileSize } from "./dom.js";
import { showToast, fileErrorMessage } from "./toast.js";
import { openImageViewer } from "./image-viewer.js";

const filePreviewArea = () => $("filePreviewArea");

// ---------------------------------------------------------------------------
// File staging helpers
// ---------------------------------------------------------------------------

async function loadImageExtras(file) {
  if (!file.path) return;
  try {
    const thumbResult = await window.assistantClient.getFileThumbnail(file.path);
    if (thumbResult.ok && thumbResult.dataUrl) file.thumbnail = thumbResult.dataUrl;
  } catch {}
  try {
    if (window.assistantClient.getImageDimensions) {
      const dimResult = await window.assistantClient.getImageDimensions(file.path);
      if (dimResult.ok && dimResult.width) file.dimensions = { width: dimResult.width, height: dimResult.height };
    }
  } catch {}
}

async function addFilesFromPaths(paths) {
  const pending = [...(store.get("pendingFiles") || [])];
  for (const filePath of paths) {
    try {
      const result = await window.assistantClient.stageFile(filePath, filePath.split("/").pop());
      if (result.ok) {
        const file = result.file;
        if (file.isImage) await loadImageExtras(file);
        pending.push(file);
      } else {
        showToast(fileErrorMessage(result.error, filePath.split("/").pop()), "warning");
      }
    } catch (err) {
      showToast(fileErrorMessage(err.message, filePath.split("/").pop()), "warning");
    }
  }
  store.set("pendingFiles", pending);
  renderFilePreview();
}

async function addFileFromPaste(buffer, fileName) {
  try {
    const result = await window.assistantClient.pasteImage(buffer, fileName);
    if (result.ok) {
      const file = result.file;
      if (file.isImage) await loadImageExtras(file);
      store.set("pendingFiles", [...(store.get("pendingFiles") || []), file]);
      renderFilePreview();
    }
  } catch (err) {
    showToast(fileErrorMessage(err.message, fileName), "warning");
  }
}

function removePendingFile(fileId) {
  const pending = (store.get("pendingFiles") || []).filter((f) => f.id !== fileId);
  store.set("pendingFiles", pending);
  renderFilePreview();
}

// ---------------------------------------------------------------------------
// File preview chips
// ---------------------------------------------------------------------------

function renderFilePreview() {
  const area = filePreviewArea();
  if (!area) return;
  area.textContent = "";

  const files = store.get("pendingFiles") || [];
  if (files.length === 0) { area.hidden = true; return; }
  area.hidden = false;

  for (const file of files) {
    const chip = document.createElement("div");
    chip.className = "file-chip";

    if (file.thumbnail) {
      const thumb = document.createElement("img");
      thumb.src = file.thumbnail;
      thumb.style.cssText = "width:28px;height:28px;border-radius:4px;object-fit:cover;cursor:pointer";
      thumb.addEventListener("click", () => openImageViewer(file.thumbnail, file.name));
      chip.appendChild(thumb);
    } else {
      const icon = document.createElement("span");
      icon.textContent = file.isImage ? "🖼" : "📎";
      icon.style.cssText = "font-size:14px;margin-right:4px";
      chip.appendChild(icon);
    }

    const name = document.createElement("span");
    name.textContent = file.name;
    name.style.cssText = "font-size:12px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    chip.appendChild(name);

    const rm = document.createElement("button");
    rm.className = "file-chip-remove";
    rm.innerHTML = "&times;";
    rm.addEventListener("click", () => removePendingFile(file.id));
    chip.appendChild(rm);

    area.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Event bindings
// ---------------------------------------------------------------------------

export function initFileHandler() {
  const composer = $("composer");
  const dropOverlay = $("dropOverlay");

  // Drag and drop on composer
  composer?.addEventListener("dragover", (e) => {
    e.preventDefault();
    composer.classList.add("drag-over");
  });

  composer?.addEventListener("dragleave", (e) => {
    e.preventDefault();
    composer.classList.remove("drag-over");
  });

  composer?.addEventListener("drop", async (e) => {
    e.preventDefault();
    composer.classList.remove("drag-over");
    if (dropOverlay) dropOverlay.hidden = true;
    const dtFiles = e.dataTransfer?.files;
    if (!dtFiles || dtFiles.length === 0) return;
    const paths = [];
    for (const f of dtFiles) { if (f.path) paths.push(f.path); }
    if (paths.length > 0) await addFilesFromPaths(paths);
  });

  // Global drag overlay
  let dragCounter = 0;
  document.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    if (dropOverlay) dropOverlay.hidden = false;
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("dragleave", (e) => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; if (dropOverlay) dropOverlay.hidden = true; }
  });
  document.addEventListener("drop", (e) => {
    dragCounter = 0;
    if (dropOverlay) dropOverlay.hidden = true;
  });

  // Clipboard paste
  document.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) {
          const MIME_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp" };
          const ext = MIME_EXT[item.type] || item.type.split("/")[1] || "png";
          await addFileFromPaste(new Uint8Array(await blob.arrayBuffer()), `pasted-${Date.now()}.${ext}`);
        }
      }
    }
  });
}
