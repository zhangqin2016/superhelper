"use strict";

const path = require("node:path");
const { BrowserWindow, screen } = require("electron");

/**
 * The collaboration panel, detached into its own window.
 *
 * It loads the SAME `index.html` with `?view=collaboration`, not a second copy
 * of the panel's markup: two copies would drift, and every fix would have to be
 * made twice. The renderer reads that flag and presents only the panel.
 *
 * Nothing about the data layer changes. `collaboration:subscribe` already keys
 * its subscriptions by `sender` (the webContents) and hands each one its own
 * unsubscribe, so a second window subscribes independently and receives its own
 * state events — it was multi-window-ready before this existed.
 */

/** Its own file on purpose: `locale-settings` writes `app-preferences.json`
 *  wholesale, so anything else stored beside it would be wiped the next time
 *  the language changed. */
function boundsStore() {
  const fs = require("node:fs");
  const { userDataPath } = require("./config");
  const file = () => userDataPath("collaboration-window.json");
  return {
    read() {
      try {
        const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
        const { x, y, width, height } = raw || {};
        return [x, y, width, height].every((value) => Number.isFinite(value)) ? { x, y, width, height } : null;
      } catch { return null; }
    },
    write(bounds) {
      try {
        const target = file();
        fs.mkdirSync(require("node:path").dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(bounds, null, 2), "utf8");
      } catch { /* a forgotten position is not worth an error */ }
    },
  };
}

/**
 * Keep the window on a display that still exists — a remembered position from a
 * monitor that has been unplugged would open it off screen.
 *
 * Pure and exported on purpose: macOS clamps an off-screen window into a
 * display by itself, so a test that creates a window and reads its bounds back
 * cannot tell whether this ran. Windows and Linux do not always clamp.
 *
 * @param bounds remembered bounds, or anything at all
 * @param workAreaFor resolves the work area of the display nearest `bounds`
 */
function boundsOnAVisibleDisplay(bounds, workAreaFor) {
  if (!bounds) return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null;
  const area = workAreaFor(bounds);
  if (!area) return null;
  // A little of the window has to be reachable: enough of the title bar to
  // grab, and enough width that it is visibly there.
  const fitsX = x + 80 > area.x && x < area.x + area.width - 80;
  const fitsY = y + 40 > area.y && y < area.y + area.height - 40;
  return fitsX && fitsY ? bounds : null;
}

const MIN_WIDTH = 760;
const MIN_HEIGHT = 560;
const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 760;

function createCollaborationWindowManager({
  rendererFile = path.join(__dirname, "..", "renderer", "index.html"),
  preload = path.join(__dirname, "..", "preload.js"),
  icon = (() => { try { return require("./app-icon").loadAppIconImage(); } catch { return null; } })(),
  backgroundColor = "#0f1119",
  readBounds = () => null,
  writeBounds = () => {},
  onClosed = () => {},
  wire = () => {},
} = {}) {
  let win = null;

  const visibleBounds = (bounds) => boundsOnAVisibleDisplay(bounds, (target) => {
    try { return screen.getDisplayMatching(target)?.workArea || null; } catch { return null; }
  });

  const remember = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    try { writeBounds(win.getNormalBounds ? win.getNormalBounds() : win.getBounds()); } catch { /* best effort */ }
  };

  return Object.freeze({
    isOpen() { return Boolean(win && !win.isDestroyed()); },

    /** Open it, or focus the one that is already there. A second window would
     *  be two views of the same conversation list fighting over focus. */
    open() {
      if (win && !win.isDestroyed()) { win.show(); win.focus(); return win; }
      const stored = visibleBounds(readBounds());
      win = new BrowserWindow({
        width: stored?.width || DEFAULT_WIDTH,
        height: stored?.height || DEFAULT_HEIGHT,
        ...(stored ? { x: stored.x, y: stored.y } : {}),
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        title: "Lily",
        ...(icon ? { icon } : {}),
        backgroundColor,
        webPreferences: {
          preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          backgroundThrottling: false,
        },
      });
      // The flag the renderer branches on. A query rather than a separate file,
      // so there is one panel implementation.
      win.loadFile(rendererFile, { query: { view: "collaboration" } });
      // The same chrome the main window gets. Without this a right-click has no
      // menu and an external link would try to navigate this window.
      try { require("./window-links").wireExternalLinks(win); } catch { /* optional */ }
      try { require("./window-context-menu").wireContextMenu(win); } catch { /* optional */ }
      wire(win);
      for (const event of ["resize", "move"]) win.on(event, remember);
      win.on("close", remember);
      win.on("closed", () => { win = null; try { onClosed(); } catch { /* best effort */ } });
      return win;
    },

    close() {
      if (!win || win.isDestroyed()) return false;
      win.close();
      return true;
    },

    focus() {
      if (!win || win.isDestroyed()) return false;
      win.show(); win.focus();
      return true;
    },
  });
}

module.exports = { createCollaborationWindowManager, boundsStore, boundsOnAVisibleDisplay, MIN_WIDTH, MIN_HEIGHT, DEFAULT_WIDTH, DEFAULT_HEIGHT };
