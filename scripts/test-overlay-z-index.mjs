#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const baseCss = read("src/renderer/styles/base.css");
const overlaysCss = read("src/renderer/styles/overlays.css");
const settingsCss = read("src/renderer/styles/settings.css");
const imageViewerCss = read("src/renderer/styles/image-viewer.css");

function tokenValue(name) {
  const match = baseCss.match(new RegExp(`${name}:\\s*(\\d+)\\s*;`));
  assert.ok(match, `missing ${name}`);
  return Number(match[1]);
}

const settingsPanelZ = tokenValue("--z-settings-panel");
const modalZ = tokenValue("--z-modal");
const imageViewerZ = tokenValue("--z-image-viewer");
const dropOverlayZ = tokenValue("--z-drop-overlay");
const notificationQueueZ = tokenValue("--z-notification-queue");
const toastZ = tokenValue("--z-toast");

assert.ok(settingsPanelZ < modalZ, "modal dialogs must appear above the settings panel");
assert.ok(settingsPanelZ < imageViewerZ, "image viewer must appear above the settings panel");
assert.ok(modalZ <= imageViewerZ, "image viewer should not sit below normal dialogs");
assert.ok(modalZ < dropOverlayZ, "file drop overlay should sit above normal dialogs");
assert.ok(dropOverlayZ < notificationQueueZ, "non-blocking notifications should sit above file drop overlay");
assert.ok(notificationQueueZ < toastZ, "toast should be the top transient UI layer");

assert.match(settingsCss, /z-index:\s*var\(--z-settings-panel\)/);
assert.match(overlaysCss, /z-index:\s*var\(--z-modal\)/);
assert.match(overlaysCss, /z-index:\s*var\(--z-drop-overlay\)/);
assert.match(overlaysCss, /z-index:\s*var\(--z-notification-queue\)/);
assert.match(overlaysCss, /z-index:\s*var\(--z-toast\)/);
assert.match(imageViewerCss, /z-index:\s*var\(--z-image-viewer\)/);

console.log("overlay-z-index: ok");
