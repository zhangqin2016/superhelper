import { t } from "../i18n/index.js";
import { revealLocalFileInFolder } from "./file-reveal.js";
import { showToast } from "./toast.js";

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

function makeAction(label, disabled, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "assistant-renderer-action";
  button.textContent = label;
  button.disabled = Boolean(disabled);
  if (!disabled) button.addEventListener("click", handler);
  return button;
}

export function renderHtmlBlock(block = {}) {
  const section = document.createElement("section");
  section.className = "assistant-renderer-block assistant-renderer-html";

  const header = document.createElement("div");
  header.className = "assistant-renderer-artifact-header";
  const title = document.createElement("strong");
  title.className = "assistant-renderer-artifact-title";
  title.textContent = displayName(block);

  const actions = document.createElement("div");
  actions.className = "assistant-renderer-chart-actions";
  actions.appendChild(makeAction(t("file.reveal"), !block.path, () => void revealLocalFileInFolder(block.path)));
  actions.appendChild(makeAction(t("common.copy"), false, async () => {
    try {
      await navigator.clipboard.writeText(String(block.path || block.relativePath || block.fileName || ""));
      showToast(t("common.copied"), "success");
    } catch {
      showToast(t("common.copyFailed"), "warning");
    }
  }));
  header.append(title, actions);

  const frame = document.createElement("iframe");
  frame.className = "assistant-html-preview";
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

  const note = document.createElement("div");
  note.className = "assistant-renderer-meta assistant-html-note";
  note.textContent = tr("renderer.htmlSandboxed", "Previewed safely without scripts.");

  section.append(header, frame, note);
  return section;
}
