import { t } from "../i18n/index.js";
import { renderFileCard } from "./preview-card.js";

function tr(key, fallback, params) {
  const value = t(key, params);
  return value === key ? fallback : value;
}

function fileUrlFromPath(filePath = "") {
  const value = String(filePath || "");
  if (/^(https?:|file:|blob:|data:)/i.test(value)) return value;
  if (/^[A-Za-z]:[\\/]/.test(value)) return `file:///${value.replace(/\\/g, "/")}`;
  if (value.startsWith("/")) return `file://${value}`;
  return value;
}

function displayName(block = {}) {
  return block.title || block.relativePath || block.fileName || block.path || tr("artifact.untitled", "Artifact");
}

function base64ToText(value = "") {
  try {
    return new TextDecoder("utf-8").decode(Uint8Array.from(atob(String(value || "")), (char) => char.charCodeAt(0)));
  } catch {
    return "";
  }
}

/** The sandboxed, script-free HTML preview frame the preview pane shows. */
export function createHtmlPreviewFrame(block = {}) {
  const frame = document.createElement("iframe");
  frame.className = "preview-pane-frame";
  frame.title = displayName(block);
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.referrerPolicy = "no-referrer";

  const srcdoc = block.html || block.text || (block.data ? base64ToText(block.data) : "");
  if (srcdoc) {
    frame.srcdoc = srcdoc;
  } else if (block.path || block.url) {
    frame.src = fileUrlFromPath(block.path || block.url);
  } else {
    frame.srcdoc = `<p>${tr("renderer.htmlPreviewEmpty", "HTML preview is empty.")}</p>`;
  }
  return frame;
}

/** In the chat, an HTML file is a card; its preview opens in the pane. */
export function renderHtmlBlock(block = {}) {
  return renderFileCard(block, "html");
}
