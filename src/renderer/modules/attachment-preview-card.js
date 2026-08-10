import { formatFileSize } from "./dom.js";
import { openImageViewer } from "./image-viewer.js";
import { openLocalFile, revealLocalFileInFolder } from "./file-reveal.js";
import { attachmentMediaPath, attachmentPreviewKind, attachmentPreviewPath } from "./attachment-preview-model.js";
import { t } from "../i18n/index.js";

function appFileUrl(filePath) {
  return filePath ? `app-file://media/${encodeURIComponent(filePath)}` : "";
}

function fileLabel(file = {}) {
  return String(file.name || file.sourcePath || file.path || t("artifact.untitled")).trim();
}

function makeButton(label, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "runtime-attachment-action";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.disabled = typeof onClick !== "function";
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

function addFileActions(card, file, sessionId) {
  const filePath = attachmentPreviewPath(file);
  const actions = document.createElement("div");
  actions.className = "runtime-attachment-actions";
  actions.append(
    makeButton(t("file.open"), t("file.open"), filePath ? () => void openLocalFile(filePath, sessionId) : null),
    makeButton(t("file.reveal"), t("file.reveal"), filePath ? () => void revealLocalFileInFolder(filePath, sessionId) : null),
  );
  card.appendChild(actions);
}

function addTextPreview(card, file) {
  const path = attachmentMediaPath(file);
  if (!path || !window.assistantClient?.readTextFile) return;
  const preview = document.createElement("pre");
  preview.className = "runtime-attachment-text";
  preview.textContent = t("file.textPreviewLoading");
  card.appendChild(preview);
  void window.assistantClient.readTextFile(path, { maxBytes: 24 * 1024 }).then((result) => {
    if (!preview.isConnected) return;
    if (!result?.ok) {
      preview.textContent = t("file.textPreviewFailed");
      return;
    }
    preview.textContent = `${result.text || ""}${result.truncated ? "\n\n…" : ""}`;
  }).catch(() => {
    if (preview.isConnected) preview.textContent = t("file.textPreviewFailed");
  });
}

function addImagePreview(card, file) {
  const path = attachmentMediaPath(file);
  const source = file.thumbnail || appFileUrl(path);
  if (!source) return;
  const image = document.createElement("img");
  image.className = "runtime-attachment-image";
  image.src = source;
  image.alt = fileLabel(file);
  image.loading = "lazy";
  image.addEventListener("click", () => openAttachmentPreview(file));
  if (file.thumbnail || !window.assistantClient?.localMediaStatus) {
    card.appendChild(image);
    return;
  }
  // Files kept in place (rather than staged) may be outside app-file's
  // allow-list. Do not show a broken thumbnail; keep the reliable file actions.
  void window.assistantClient.localMediaStatus(path).then((status) => {
    if (status?.ok && card.isConnected) card.appendChild(image);
  }).catch(() => {});
}

function addPdfAction(card, file) {
  const path = attachmentMediaPath(file);
  if (!path) return;
  const read = makeButton(t("renderer.pdfOpenViewer"), t("renderer.pdfOpenViewer"), async () => {
    const { openPdfViewer } = await import("./pdf-viewer.js");
    openPdfViewer({ path, title: fileLabel(file), bytes: file.size });
  });
  card.querySelector(".runtime-attachment-actions")?.prepend(read);
}

export function renderAttachmentPreviews(container, files = [], { sessionId = "" } = {}) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!container || !list.length) return;
  const grid = document.createElement("div");
  grid.className = "runtime-attachment-grid";
  for (const file of list) {
    const kind = attachmentPreviewKind(file);
    const card = document.createElement("section");
    card.className = `runtime-attachment-card is-${kind}`;
    const header = document.createElement("div");
    header.className = "runtime-attachment-header";
    const name = document.createElement("strong");
    name.textContent = fileLabel(file);
    name.title = fileLabel(file);
    const meta = document.createElement("span");
    meta.textContent = file.size ? formatFileSize(file.size) : kind === "folder" ? t("file.reveal") : "";
    header.append(name, meta);
    card.appendChild(header);
    if (kind === "image") addImagePreview(card, file);
    if (kind === "text") addTextPreview(card, file);
    addFileActions(card, file, sessionId);
    if (kind === "pdf") addPdfAction(card, file);
    grid.appendChild(card);
  }
  container.appendChild(grid);
}

export function openAttachmentPreview(file = {}, sessionId = "") {
  const kind = attachmentPreviewKind(file);
  const path = attachmentPreviewPath(file);
  if (kind === "image") {
    const source = file.thumbnail || appFileUrl(attachmentMediaPath(file));
    if (!source) return;
    if (file.thumbnail || !window.assistantClient?.localMediaStatus) {
      openImageViewer(source, fileLabel(file));
      return;
    }
    void window.assistantClient.localMediaStatus(attachmentMediaPath(file)).then((status) => {
      if (status?.ok) openImageViewer(source, fileLabel(file));
      else if (path) void openLocalFile(path, sessionId);
    }).catch(() => {
      if (path) void openLocalFile(path, sessionId);
    });
    return;
  }
  const mediaPath = attachmentMediaPath(file);
  if (kind === "pdf" && mediaPath) {
    void import("./pdf-viewer.js").then(({ openPdfViewer }) => openPdfViewer({ path: mediaPath, title: fileLabel(file), bytes: file.size }));
    return;
  }
  if (path) void openLocalFile(path, sessionId);
}
