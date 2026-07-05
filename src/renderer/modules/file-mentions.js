/**
 * Turn inline file mentions in an answer (e.g. `output/chart.svg`) into a small
 * affordance: previewable files open in the OS default app (quick preview),
 * everything else reveals in its folder. Relative mentions are opened only when
 * they match a declared result block/artifact, so the renderer never guesses a
 * workspace base directory for arbitrary text.
 */
import { openLocalFile, revealLocalFileInFolder } from "./file-reveal.js";
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
const UNSAFE_ABSOLUTE_PATH_CHARS_RE = /[<>"|*?]/;

function isOpenableLocalPath(filePath = "") {
  const value = String(filePath || "").trim();
  return /^file:/i.test(value) || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function mentionExtension(raw = "") {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^file:/i.test(value)) {
    try {
      return (new URL(value).pathname.match(/\.([a-z0-9]{1,8})$/i)?.[1] || "").toLowerCase();
    } catch {
      return "";
    }
  }
  return (value.match(/\.([a-z0-9]{1,8})$/i)?.[1] || "").toLowerCase();
}

function classifyMentionPath(raw, ext) {
  if (PREVIEWABLE_EXT.has(ext)) return { path: raw, ext, previewable: true };
  if (REVEAL_EXT.has(ext)) return { path: raw, ext, previewable: false };
  return null;
}

/** Classify a code-span's text as a file mention, or null if it isn't one. */
export function fileMentionInfo(text) {
  const raw = String(text || "").trim();
  if (!raw || /[\r\n]/.test(raw)) return null;
  if (isOpenableLocalPath(raw)) {
    if (UNSAFE_ABSOLUTE_PATH_CHARS_RE.test(raw)) return null;
    return classifyMentionPath(raw, mentionExtension(raw));
  }
  if (/\s/.test(raw)) return null;
  const m = FILE_TOKEN_RE.exec(raw);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return classifyMentionPath(raw, ext);
}

function addPathAlias(map, alias, target) {
  const key = String(alias || "").trim();
  const value = String(target || "").trim();
  if (!key || !value || map.has(key)) return;
  map.set(key, value);
}

function artifactPathMap(blocks = []) {
  const map = new Map();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const target = block?.path;
    if (!isOpenableLocalPath(target)) continue;
    addPathAlias(map, block.path, target);
    addPathAlias(map, block.relativePath, target);
    addPathAlias(map, block.fileName, target);
  }
  return map;
}

function actionPathForMention(pathText, pathMap) {
  const raw = String(pathText || "").trim();
  if (isOpenableLocalPath(raw)) return raw;
  return pathMap.get(raw) || "";
}

const ICON_PREVIEW =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
const ICON_FOLDER =
  '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z"/></svg>';

/** Append a small preview/reveal button after each inline file mention in `root`. */
export function enhanceFileMentions(root, sessionId = "", blocks = []) {
  if (!root) return;
  const pathMap = artifactPathMap(blocks);
  for (const code of root.querySelectorAll("code")) {
    if (code.dataset.fileAction === "1" || code.closest("pre")) continue;
    const info = fileMentionInfo(code.textContent);
    if (!info) continue;
    const actionPath = actionPathForMention(info.path, pathMap);
    if (!actionPath) continue;
    code.dataset.fileAction = "1";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "file-mention-action";
    btn.title = info.previewable ? t("file.preview") : t("file.reveal");
    btn.innerHTML = info.previewable ? ICON_PREVIEW : ICON_FOLDER;
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (info.previewable) {
        void openLocalFile(actionPath, sessionId);
      } else {
        void revealLocalFileInFolder(actionPath, sessionId);
      }
    });
    code.insertAdjacentElement("afterend", btn);
  }
}
