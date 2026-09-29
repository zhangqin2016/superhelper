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

// A page with a file runs on its workspace's own lily-preview:// origin
// (preview-protocol.js): scripts, its own files and storage work, as in a
// browser, while the app window — file://, another origin — stays out of its
// reach. Inline HTML with no file runs on an opaque origin. Without a preview
// URL (no bridge, file outside a workspace) the previous script-free view
// shows, and why is logged.
const OWN_ORIGIN_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";
const OPAQUE_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals";
const SCRIPT_FREE_SANDBOX = "allow-same-origin";

/** The HTML preview frame the preview pane shows. */
export function createHtmlPreviewFrame(block = {}) {
  const frame = document.createElement("iframe");
  frame.className = "preview-pane-frame";
  frame.title = displayName(block);
  frame.referrerPolicy = "no-referrer";

  const srcdoc = block.html || block.text || (block.data ? base64ToText(block.data) : "");
  if (srcdoc) {
    frame.setAttribute("sandbox", OPAQUE_SANDBOX);
    frame.srcdoc = srcdoc;
    return frame;
  }
  const target = block.path || block.url || "";
  if (!target) {
    frame.setAttribute("sandbox", SCRIPT_FREE_SANDBOX);
    frame.srcdoc = `<p>${tr("renderer.htmlPreviewEmpty", "HTML preview is empty.")}</p>`;
    return frame;
  }
  const scriptFree = (reason) => {
    console.warn("[html-preview] showing without scripts:", target, reason);
    frame.setAttribute("sandbox", SCRIPT_FREE_SANDBOX);
    frame.src = fileUrlFromPath(target);
  };
  const previewUrl = window.assistantClient?.previewUrl;
  if (!block.path || typeof previewUrl !== "function") {
    scriptFree(block.path ? "no preview bridge" : "not a local file");
    return frame;
  }
  // The sandbox is set before the first navigation, the only one it applies to.
  frame.setAttribute("sandbox", OWN_ORIGIN_SANDBOX);
  Promise.resolve(previewUrl(block.path)).then((result) => {
    if (result?.ok && result.url) frame.src = result.url;
    else scriptFree(result?.error || "no preview url");
  }, (error) => scriptFree(error?.message || String(error)));
  return frame;
}

/** In the chat, an HTML file is a card; its preview opens in the pane. */
export function renderHtmlBlock(block = {}) {
  return renderFileCard(block, "html");
}
