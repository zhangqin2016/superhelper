#!/usr/bin/env node
"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const root = path.join(__dirname, "..");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(root, "src/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on("console-message", (_e, _level, msg) => {
    if (String(msg).includes("does not provide an export")) {
      console.error("CONSOLE:", msg);
    }
  });
  await win.loadFile(path.join(root, "src/renderer/index.html"));
  await new Promise((r) => setTimeout(r, 1500));
  const result = await win.webContents.executeJavaScript(`(
    async () => {
      const results = [];
      for (const spec of [
        "./modules/engine-notice-policy.js",
        "./modules/tool-payload-renderer.js",
        "./modules/turn-view-renderer.js",
        "./modules/session-runtime-store.js",
        "./modules/message.js",
        "./app.js",
      ]) {
        try {
          await import(spec);
          results.push(spec + ": ok");
        } catch (e) {
          results.push(spec + ": FAIL " + e.message);
        }
      }
      return results.join("\\n");
    }
  )()`);
  console.log(result);
  if (result.includes("FAIL")) {
    app.exitCode = 1;
  } else {
    console.log("test-renderer-import: ok");
  }
  app.quit();
});
