"use strict";

const fs = require("node:fs");
const { fileURLToPath } = require("node:url");
const { shell } = require("electron");

function isHttpOrMailto(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:";
  } catch {
    return false;
  }
}

function isFileUrl(url) {
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

function isInternalAppUrl(webContents, url) {
  if (url === webContents.getURL()) return true;
  try {
    const target = new URL(url);
    const current = new URL(webContents.getURL());
    return target.protocol === "file:" && target.pathname === current.pathname;
  } catch {
    return false;
  }
}

/**
 * Open a local path in the OS file manager (Finder / Explorer / etc.).
 * Files are revealed and selected; folders open directly.
 */
function openLocalFileUrl(url) {
  let localPath;
  try {
    localPath = fileURLToPath(url);
  } catch {
    return false;
  }

  if (!fs.existsSync(localPath)) {
    void shell.openPath(localPath);
    return true;
  }

  const stat = fs.statSync(localPath);
  if (stat.isDirectory()) {
    void shell.openPath(localPath);
  } else {
    shell.showItemInFolder(localPath);
  }
  return true;
}

/**
 * Candidates for an address that does not parse as written, best first.
 *
 * A model can write a URL that runs into the following punctuation
 * ("http://127.0.0.1:5173，88") — and before 2026-09-15 a click on it did
 * NOTHING: the navigation was cancelled and every open path rejected the
 * malformed string, so the user got silence. Even a wrong address should reach
 * the browser and be allowed to 404. Percent-encoding rescues stray characters;
 * the longest parseable prefix rescues a URL whose tail is not part of it.
 */
function openableCandidates(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const seen = new Set();
  const candidates = [];
  const add = (value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };
  add(text);
  try {
    // eslint-disable-next-line no-new
    new URL(text);
    return candidates; // it already parses; nothing to repair
  } catch { /* fall through to the repairs */ }
  try { add(encodeURI(text)); } catch { /* not encodable */ }
  for (let end = text.length - 1; end > "https://".length; end -= 1) {
    try {
      const prefix = text.slice(0, end);
      // eslint-disable-next-line no-new
      new URL(prefix);
      add(prefix);
      break;
    } catch { /* keep shrinking */ }
  }
  return candidates;
}

function openExternalUrl(url) {
  for (const candidate of openableCandidates(url)) {
    if (isHttpOrMailto(candidate)) {
      if (candidate !== url) console.warn("[window] opening a repaired address:", url, "->", candidate);
      void shell.openExternal(candidate);
      return true;
    }
    if (isFileUrl(candidate)) return openLocalFileUrl(candidate);
  }
  // Nothing parsed. Hand the raw string to the OS anyway so the browser can show
  // its own error instead of the click being swallowed in silence.
  console.warn("[window] address could not be parsed; handing it to the OS as-is:", url);
  try { void shell.openExternal(String(url || "")); } catch { /* the OS refused it too */ }
  return false;
}

/** Keep the app shell on index.html; open links in the system browser or file manager. */
function wireExternalLinks(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isInternalAppUrl(win.webContents, url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });
}

module.exports = { wireExternalLinks, openExternalUrl, openLocalFileUrl, openableCandidates };
