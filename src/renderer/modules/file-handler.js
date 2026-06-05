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

async function addFileFromBuffer(buffer, fileName) {
  try {
    const result = await window.assistantClient.pasteFile(buffer, fileName);
    if (result.ok) {
      const file = result.file;
      if (file.isImage) await loadImageExtras(file);
      store.set("pendingFiles", [...(store.get("pendingFiles") || []), file]);
      renderFilePreview();
    } else {
      showToast(fileErrorMessage(result.error, fileName), "warning");
    }
  } catch (err) {
    showToast(fileErrorMessage(err.message, fileName), "warning");
  }
}

async function addBrowserFiles(files) {
  const list = [...(files || [])].filter(Boolean);
  if (list.length === 0) return;
  const pending = [...(store.get("pendingFiles") || [])];
  for (const browserFile of list) {
    const name = browserFile.name || `pasted-${Date.now()}`;
    try {
      const filePath = await window.assistantClient.getPathForFile?.(browserFile);
      const result = filePath
        ? await window.assistantClient.stageFile(filePath, name)
        : await window.assistantClient.pasteFile(new Uint8Array(await browserFile.arrayBuffer()), name);
      if (result.ok) {
        const file = result.file;
        if (file.isImage) await loadImageExtras(file);
        pending.push(file);
      } else {
        showToast(fileErrorMessage(result.error, name), "warning");
      }
    } catch (err) {
      showToast(fileErrorMessage(err.message, name), "warning");
    }
  }
  store.set("pendingFiles", pending);
  renderFilePreview();
}

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

    if (file.isImage && file.thumbnail) {
      const thumb = document.createElement("img");
      thumb.className = "file-chip-img";
      thumb.src = file.thumbnail;
      thumb.alt = file.name;
      thumb.addEventListener("click", () => openImageViewer(file.thumbnail, file.name));
      chip.appendChild(thumb);
    } else {
      const icon = document.createElement("span");
      icon.className = "file-chip-icon";
      icon.textContent = file.isImage ? "🖼" : "📄";
      chip.appendChild(icon);
    }

    const name = document.createElement("span");
    name.className = "file-chip-name";
    name.textContent = file.name;
    chip.appendChild(name);

    const rm = document.createElement("button");
    rm.className = "file-chip-remove";
    rm.innerHTML = "&times;";
    rm.addEventListener("click", () => removePendingFile(file.id));
    chip.appendChild(rm);

    area.appendChild(chip);
  }
}

function removePendingFile(fileId) {
  const pending = (store.get("pendingFiles") || []).filter((f) => f.id !== fileId);
  store.set("pendingFiles", pending);
  renderFilePreview();
}

export function clearPendingFiles() {
  store.set("pendingFiles", []);
  renderFilePreview();
}

export { renderFilePreview };

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
    e.stopPropagation();
    composer.classList.remove("drag-over");
    if (dropOverlay) dropOverlay.hidden = true;
    const dtFiles = e.dataTransfer?.files;
    if (dtFiles?.length) await addBrowserFiles(dtFiles);
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
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragCounter = 0;
    composer?.classList.remove("drag-over");
    if (dropOverlay) dropOverlay.hidden = true;
    const dtFiles = e.dataTransfer?.files;
    if (dtFiles?.length) await addBrowserFiles(dtFiles);
  });

  // Clipboard paste
  document.addEventListener("paste", async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [...items]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length > 0) {
      e.preventDefault();
      await addBrowserFiles(files);
      return;
    }
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) await addFileFromBuffer(new Uint8Array(await blob.arrayBuffer()), `pasted-${Date.now()}.png`);
      }
    }
  });
}
