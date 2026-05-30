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

function openExternalUrl(url) {
  if (isHttpOrMailto(url)) {
    void shell.openExternal(url);
    return true;
  }
  if (isFileUrl(url)) {
    return openLocalFileUrl(url);
  }
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

module.exports = { wireExternalLinks, openExternalUrl, openLocalFileUrl };
