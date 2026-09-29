/**
 * The chat's card for a file a turn produced or named. Readable files (HTML,
 * Markdown, PDF, images) open in the preview pane beside the chat, as ChatGPT
 * and Claude show an artifact; where there is no pane the file opens in its
 * system app.
 */

import { t } from "../i18n/index.js";
import { openLocalFile, revealLocalFileInFolder } from "./file-reveal.js";
import { tryOpenInPreviewPane } from "./preview-pane.js";
import { artifactDisplayName, artifactSourceUrl, bytesText } from "./turn-renderer-block-model.js";
import { iconButton } from "./ui-icons.js";
import { extensionOf, isBrowserImage } from "../../shared/file-kinds.mjs";

function tr(key, fallback) {
  const value = t(key);
  return value === key ? fallback : value;
}

export function revealButton(block = {}) {
  const button = iconButton("assistant-reveal-btn", "reveal", t("file.reveal"), {
    onClick: () => { if (block.path) void revealLocalFileInFolder(block.path); },
  });
  button.disabled = !block.path;
  return button;
}

const KIND_LABEL = { html: "HTML", markdown: "Markdown", pdf: "PDF" };

const PANE_KIND_BY_EXT = { ".html": "html", ".htm": "html", ".md": "markdown", ".markdown": "markdown", ".pdf": "pdf" };

/** The preview-pane kind that reads this file ("" when the pane cannot). */
export function paneKindForPath(filePath = "") {
  const ext = extensionOf(filePath);
  return PANE_KIND_BY_EXT[ext] || (isBrowserImage(ext) ? "image" : "");
}

/**
 * Open a file the one way the app does, wherever it is named (a result card,
 * a path in the answer): readable kinds in the preview pane beside the chat,
 * anything else — or any window without a pane — in its system app.
 */
export function openFile({ path = "", title = "", kind = paneKindForPath(path), block = null, sessionId = "" } = {}) {
  const src = kind === "image" ? artifactSourceUrl(block || { path }) : "";
  if (kind && tryOpenInPreviewPane({ kind, path, src, title: title || path, ...(block ? { block } : {}) })) return;
  if (path) void openLocalFile(path, sessionId);
}

function extensionLabel(block = {}) {
  const ext = String(block.ext || String(block.path || block.fileName || "").match(/\.([^./\\]+)$/)?.[1] || "")
    .replace(/^\./, "");
  return ext ? ext.toUpperCase() : "";
}

/**
 * A file the turn produced or named, as one card: its own name first, its
 * type and size below, the full path on hover. `kind` — "html", "markdown",
 * "pdf" or "image" — adds "open on the right" (the preview pane); any other
 * file is revealed in its folder.
 * @param {object} block
 * @param {"html"|"markdown"|"pdf"|"image"|""} [kind]
 */
export function renderFileCard(block = {}, kind = "") {
  const name = artifactDisplayName(block, tr("artifact.untitled", "Artifact"));
  const canPreview = Boolean(kind) && Boolean(block.path || block.url || block.html || block.text || block.data);
  const open = () => openFile({ path: block.path || block.url || "", title: name, kind, block });

  const figure = document.createElement("figure");
  figure.className = `assistant-renderer-block assistant-renderer-artifact is-file is-compact${kind ? " is-previewable" : ""}`;
  if (kind) figure.dataset.previewKind = kind;
  const caption = document.createElement("figcaption");

  // The file's own name leads; the path it lives at is the tooltip. A card
  // showing the path from its start truncated every file to "output/…".
  const fileName = String(block.fileName || name).split(/[\\/]/).pop() || name;
  const text = document.createElement("div");
  text.className = "assistant-preview-card-text";
  // On the wrapper: the name clips its own overflow for the ellipsis.
  text.dataset.tip = name;
  const title = document.createElement("strong");
  title.className = "assistant-generated-file-path assistant-preview-card-name";
  title.textContent = fileName;
  title.dataset.path = block.relativePath || block.path || "";
  if (canPreview) title.addEventListener("click", open);
  const meta = document.createElement("span");
  meta.className = "assistant-renderer-meta";
  meta.textContent = [KIND_LABEL[kind] || extensionLabel(block), bytesText(block.bytes)].filter(Boolean).join(" · ");
  text.append(title, meta);
  caption.appendChild(text);

  if (kind) {
    const openButton = iconButton("assistant-reveal-btn assistant-preview-open", "openInPane", tr("preview.openInPane", "Open on the right"), { onClick: open });
    openButton.disabled = !canPreview;
    caption.appendChild(openButton);
  }
  caption.appendChild(revealButton(block));

  figure.appendChild(caption);
  return figure;
}
