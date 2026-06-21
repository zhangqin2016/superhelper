/**
 * Turn inline file mentions in an answer (e.g. `output/chart.svg`) into a small
 * affordance: previewable files open in the OS default app (quick preview),
 * everything else reveals in its folder. Bare/relative paths are resolved against
 * the session workspace on the main side (filetree:open / filetree:reveal).
 */
import { revealLocalFileInFolder } from "./file-reveal.js";
import { t } from "../i18n/index.js";

// Curated deliverable extensions only — NOT any "word.ext" token, so version
// numbers ("v1.2"), sizes ("3.6"), and prose dots never get an icon.
const PREVIEWABLE_EXT = new Set([
  "svg", "png", "jpg", "jpeg", "gif", "webp", "bmp", "pdf",
  "html", "htm", "md", "txt", "csv", "json", "mp4", "webm", "mp3", "wav",
  "docx", "xlsx", "pptx", "doc", "xls", "ppt",
]);
const REVEAL_EXT = new Set(["zip", "gz", "tar", "tgz", "7z", "rar", "db", "sqlite", "exe", "dmg", "bin", "iso"]);

const FILE_TOKEN_RE = /^[^\s<>|:"*?]+\.([a-z0-9]{1,8})$/i;

/** Classify a code-span's text as a file mention, or null if it isn't one. */
export function fileMentionInfo(text) {
  const raw = String(text || "").trim();
  if (!raw || /\s/.test(raw)) return null;
  const m = FILE_TOKEN_RE.exec(raw);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (PREVIEWABLE_EXT.has(ext)) return { path: raw, ext, previewable: true };
  if (REVEAL_EXT.has(ext)) return { path: raw, ext, previewable: false };
  return null;
}

const ICON_PREVIEW =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
const ICON_FOLDER =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z"/></svg>';

/** Append a small preview/reveal button after each inline file mention in `root`. */
export function enhanceFileMentions(root, sessionId = "") {
  if (!root) return;
  for (const code of root.querySelectorAll("code")) {
    if (code.dataset.fileAction === "1" || code.closest("pre")) continue;
    const info = fileMentionInfo(code.textContent);
    if (!info) continue;
    code.dataset.fileAction = "1";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "file-mention-action";
    btn.title = info.previewable ? t("file.preview") : t("file.reveal");
    btn.innerHTML = info.previewable ? ICON_PREVIEW : ICON_FOLDER;
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (info.previewable && window.assistantClient?.openLocalFile) {
        void window.assistantClient.openLocalFile(info.path, sessionId);
      } else {
        void revealLocalFileInFolder(info.path, sessionId);
      }
    });
    code.insertAdjacentElement("afterend", btn);
  }
}
