#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

if (!app?.whenReady || !BrowserWindow) {
  console.error("test-scroll-autofollow must run under Electron");
  process.exit(2);
}

let win = null;
const hardTimeout = setTimeout(() => {
  console.error("scroll-autofollow: timed out");
  win?.destroy?.();
  app.exit(1);
  process.exit(1);
}, 20_000);

function finish(code) {
  clearTimeout(hardTimeout);
  win?.destroy?.();
  app.exit(code);
  setTimeout(() => process.exit(code), 100).unref?.();
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(__dirname, "../fixtures/renderer/scroll-autofollow.html"));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const {
      bindPanelScroll,
      isUserScrollDetached,
      scrollToBottom,
      scrollToBottomAfterLayout,
    } = await import("../../src/renderer/modules/dom.js");
    const panel = document.getElementById("panel");
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    bindPanelScroll(panel);
    scrollToBottom(true, panel);
    await frames();

    const bottomTop = panel.scrollTop;
    const userTop = Math.max(0, bottomTop - 120);
    scrollToBottomAfterLayout(panel, true);
    panel.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    panel.scrollTop = userTop;
    panel.dispatchEvent(new Event("scroll"));
    await frames();

    const afterQueuedFollow = panel.scrollTop;
    const detached = isUserScrollDetached(panel);
    scrollToBottom(true, panel);
    await frames();
    return {
      bottomTop,
      userTop,
      afterQueuedFollow,
      detached,
      reattached: !isUserScrollDetached(panel),
      finalTop: panel.scrollTop,
    };
  })()`);

  assert(result.bottomTop > 1_000, "fixture must be genuinely scrollable");
  assert.equal(result.detached, true, "the first upward wheel must detach live auto-follow");
  assert(
    result.afterQueuedFollow <= result.userTop + 2,
    `queued auto-follow overrode user navigation: ${JSON.stringify(result)}`,
  );
  assert.equal(result.reattached, true, "an explicit Latest action must resume auto-follow");
  assert(result.finalTop >= result.bottomTop - 2, "Latest must return to the bottom");
  console.log("scroll-autofollow: ok");
  finish(0);
}).catch((err) => {
  console.error(err?.stack || err?.message || err);
  finish(1);
});
