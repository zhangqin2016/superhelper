"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, nativeImage } = require("electron");
const { PROJECT_ROOT } = require("./config");

function iconCandidates(fileName) {
  const list = [];
  if (app.isPackaged) {
    list.push(path.join(process.resourcesPath, "resources", fileName));
    list.push(path.join(process.resourcesPath, fileName));
  }
  list.push(path.join(PROJECT_ROOT, "resources", fileName));
  return list;
}

function firstExisting(fileNames) {
  for (const name of fileNames) {
    for (const candidate of iconCandidates(name)) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** PNG path for Dock / window / in-app UI (Electron loads this reliably). */
function resolveRuntimeIconPath() {
  return firstExisting(["icon.png"]);
}

/** Load NativeImage for Dock and BrowserWindow; null if missing or invalid. */
function loadAppIconImage() {
  const iconPath = resolveRuntimeIconPath();
  if (!iconPath) return null;
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    try {
      image = nativeImage.createFromBuffer(fs.readFileSync(iconPath));
    } catch {
      return null;
    }
  }
  if (image.isEmpty()) {
    console.warn("[app-icon] failed to load:", iconPath);
    return null;
  }
  return image;
}

let cachedDataUrl = null;

/** data: URL for renderer <img> (reliable on Windows; file:// often blocked). */
function resolveRuntimeIconDataUrl() {
  if (cachedDataUrl) return cachedDataUrl;
  const image = loadAppIconImage();
  if (!image) return null;
  const dataUrl = image.toDataURL();
  if (!dataUrl || dataUrl === "data:image/png;base64,") return null;
  cachedDataUrl = dataUrl;
  return cachedDataUrl;
}

/** file:// or data: URL fallback for renderer images. */
function resolveRuntimeIconUrl() {
  const dataUrl = resolveRuntimeIconDataUrl();
  if (dataUrl) return dataUrl;
  const iconPath = resolveRuntimeIconPath();
  return iconPath ? pathToFileURL(iconPath).href : null;
}

module.exports = {
  resolveRuntimeIconPath,
  loadAppIconImage,
  resolveRuntimeIconUrl,
  resolveRuntimeIconDataUrl,
};
