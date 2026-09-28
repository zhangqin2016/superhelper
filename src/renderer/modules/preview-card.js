/**
 * The chat's card for a file that is read in the preview pane (HTML,
 * Markdown): name, size, "open on the right", reveal. The content itself is
 * shown in the pane, as ChatGPT and Claude show an artifact beside the chat;
 * where there is no pane the file opens in its system app.
 */

import { t } from "../i18n/index.js";
import { openLocalFile, revealLocalFileInFolder } from "./file-reveal.js";
import { tryOpenInPreviewPane } from "./preview-pane.js";
import { artifactDisplayName, bytesText } from "./turn-renderer-block-model.js";
import { iconButton } from "./ui-icons.js";

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

const KIND_LABEL = { html: "HTML", markdown: "Markdown" };

/** @param {"html"|"markdown"} kind */
export function renderPreviewCard(block = {}, kind) {
  const name = artifactDisplayName(block, tr("artifact.untitled", "Artifact"));
  const canPreview = Boolean(block.path || block.url || block.html || block.text || block.data);
  const open = () => {
    if (tryOpenInPreviewPane({ kind, path: block.path || block.url || "", title: name, block })) return;
    if (block.path) void openLocalFile(block.path);
  };

  const figure = document.createElement("figure");
  figure.className = "assistant-renderer-block assistant-renderer-artifact is-file is-compact is-previewable";
  figure.dataset.previewKind = kind;
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
  meta.textContent = [KIND_LABEL[kind], bytesText(block.bytes)].filter(Boolean).join(" · ");
  text.append(title, meta);
  caption.appendChild(text);

  const openButton = iconButton("assistant-reveal-btn assistant-preview-open", "openInPane", tr("preview.openInPane", "Open on the right"), { onClick: open });
  openButton.disabled = !canPreview;
  caption.append(openButton, revealButton(block));

  figure.appendChild(caption);
  return figure;
}
