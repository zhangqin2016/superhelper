/**
 * File attachment handling: drag-drop, paste, file picker, preview chips.
 */

import store from "./state.js";
import { $, el, formatFileSize } from "./dom.js";
import { showToast, fileErrorMessage } from "./toast.js";
import { openImageViewer } from "./image-viewer.js";
import { openAttachmentPreview } from "./attachment-preview-card.js";
import { t } from "../i18n/index.js";
import { routeDroppedFiles } from "./workspace-package-drop.js";
import { reviewWorkspacePackage } from "./workspace-package-review.js";

const filePreviewArea = () => $("filePreviewArea");
const LARGE_PASTE_MIN_CHARS = 6000;
const LARGE_PASTE_MIN_BYTES = 12 * 1024;
const MAX_PATHLESS_FILE_BYTES = 20 * 1024 * 1024;

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
      return true;
    } else {
      showToast(fileErrorMessage(result.error, fileName), "warning");
    }
  } catch (err) {
    showToast(fileErrorMessage(err.message, fileName), "warning");
  }
  return false;
}

async function addStagedFiles(files) {
  const list = [...(files || [])].filter(Boolean);
  if (list.length === 0) return 0;
  const pending = [...(store.get("pendingFiles") || [])];
  for (const file of list) {
    if (file.isImage) await loadImageExtras(file);
    pending.push(file);
  }
  store.set("pendingFiles", pending);
  renderFilePreview();
  return list.length;
}

export function pastedTextByteLength(text) {
  return new TextEncoder().encode(String(text || "")).length;
}

export function shouldStagePastedText(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  return value.length >= LARGE_PASTE_MIN_CHARS || pastedTextByteLength(value) >= LARGE_PASTE_MIN_BYTES;
}

export function buildPastedTextFileName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hour = pad(now.getHours());
  const minute = pad(now.getMinutes());
  const second = pad(now.getSeconds());
  return `pasted-text-${year}${month}${day}-${hour}${minute}${second}.md`;
}

export function pastedTextToBuffer(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const content = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  return new TextEncoder().encode(content);
}

function isComposerTextPaste(event) {
  const target = event?.target;
  return target && target.id === "promptInput";
}

function insertPlainTextAtCursor(target, text) {
  if (!target || typeof target.value !== "string") return;
  const value = String(text || "");
  if (!value) return;
  if (typeof target.setRangeText === "function") {
    const start = Number.isFinite(target.selectionStart) ? target.selectionStart : target.value.length;
    const end = Number.isFinite(target.selectionEnd) ? target.selectionEnd : start;
    target.setRangeText(value, start, end, "end");
  } else {
    target.value += value;
  }
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

async function addBrowserFiles(files) {
  const list = [...(files || [])].filter(Boolean);
  if (list.length === 0) return 0;
  const staged = [];
  for (const browserFile of list) {
    const name = browserFile.name || `pasted-${Date.now()}`;
    try {
      const filePath = await window.assistantClient.getPathForFile?.(browserFile);
      const result = filePath
        ? await window.assistantClient.stageFile(filePath, name)
        : browserFile.size > MAX_PATHLESS_FILE_BYTES
          ? { ok: false, error: "FILE_TOO_LARGE" }
          : await window.assistantClient.pasteFile(new Uint8Array(await browserFile.arrayBuffer()), name);
      if (result.ok) {
        staged.push(result.file);
      } else {
        showToast(fileErrorMessage(result.error, name), "warning");
      }
    } catch (err) {
      showToast(fileErrorMessage(err.message, name), "warning");
    }
  }
  return addStagedFiles(staged);
}

async function routeBrowserDrop(files) {
  return routeDroppedFiles(files, {
    resolvePath: (file) => window.assistantClient.getPathForFile?.(file),
    inspectPath: (filePath) => window.assistantClient.inspectWorkspacePackage(filePath),
    reviewPackage: (inspection) => reviewWorkspacePackage(inspection),
    importPackage: async (payload) => {
      const result = await window.assistantClient.importWorkspacePackagePath(payload);
      if (result?.ok) {
        const { completeWorkspaceImport } = await import("./project-tree.js");
        await completeWorkspaceImport(result);
      } else if (!result?.canceled) {
        showToast(result?.error || t("toast.importPackFailed"), "error");
      }
      return result;
    },
    attachFiles: addBrowserFiles,
    previewCharacterSource: async (filePath) => {
      const { openCharacterImportPreview } = await import("./character-session-control.js");
      return openCharacterImportPreview(filePath);
    },
  });
}

async function addSystemClipboardFiles() {
  if (!window.assistantClient?.pasteClipboardFiles) return 0;
  try {
    const result = await window.assistantClient.pasteClipboardFiles();
    if (!result?.ok) {
      if (result?.error) showToast(fileErrorMessage(result.error), "warning");
      return 0;
    }
    for (const item of result.errors || []) {
      showToast(fileErrorMessage(item.error, item.path?.split(/[\\/]/).pop() || item.path), "warning");
    }
    const count = await addStagedFiles(result.files || []);
    if (count > 0) showToast(t("toast.clipboardFilesAttached", { count }), "info");
    return count;
  } catch (err) {
    showToast(fileErrorMessage(err.message || "CLIPBOARD_READ_FAILED"), "warning");
    return 0;
  }
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

    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "file-chip-preview";
    preview.textContent = t("file.preview");
    preview.title = t("file.preview");
    preview.addEventListener("click", () => openAttachmentPreview(file));
    chip.appendChild(preview);

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
    if (dtFiles?.length) await routeBrowserDrop(dtFiles);
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
    if (dtFiles?.length) await routeBrowserDrop(dtFiles);
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
      const systemFileCount = await addSystemClipboardFiles();
      if (systemFileCount > 0) return;
      await addBrowserFiles(files);
      return;
    }
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (blob) await addFileFromBuffer(new Uint8Array(await blob.arrayBuffer()), `pasted-${Date.now()}.png`);
      }
    }
    if (!isComposerTextPaste(e)) return;
    const text = e.clipboardData?.getData("text/plain") || "";
    e.preventDefault();
    const systemFileCount = await addSystemClipboardFiles();
    if (systemFileCount > 0) return;
    if (!shouldStagePastedText(text)) {
      insertPlainTextAtCursor(e.target, text);
      return;
    }
    const ok = await addFileFromBuffer(pastedTextToBuffer(text), buildPastedTextFileName());
    if (ok) showToast(t("toast.largePasteAttached"), "info");
    if (!ok) insertPlainTextAtCursor(e.target, text);
  });
}
