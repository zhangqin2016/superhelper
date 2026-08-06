#!/usr/bin/env node
"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

if (!app?.whenReady || !BrowserWindow) process.exit(2);

(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false } });
  try {
    await win.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));
    const controllerUrl = pathToFileURL(path.join(
      __dirname, "..", "src", "renderer", "modules", "character-preview-controller.js",
    )).href;
    const modelUrl = pathToFileURL(path.join(
      __dirname, "..", "src", "renderer", "modules", "character-control-model.js",
    )).href;
    const result = await win.webContents.executeJavaScript(`(async () => {
      const { createCharacterPreviewController } = await import(${JSON.stringify(controllerUrl)});
      const { initialCharacterControlState, reduceCharacterControl } = await import(${JSON.stringify(modelUrl)});
      let active = true;
      let failExit = true;
      let exitCalls = 0;
      let loadCalls = 0;
      let activateCalls = 0;
      let refreshCalls = 0;
      let activatedPayload = null;
      let state = initialCharacterControlState({
        sessionId: "session-preview",
        preview: {
          previewVersion: 1, bindingVersion: 0, character: true, persona: false,
          worldBookCount: 0, activation: null, loading: false, conflict: null,
        },
      });
      const api = {
        getPreview: async () => {
          loadCalls += 1;
          return { ok: true, preview: {
            previewVersion: active ? 2 : 3,
            bindingVersion: 0,
            character: active,
            persona: false,
            worldBookCount: 0,
            activation: null,
          } };
        },
        exitPreview: async () => {
          exitCalls += 1;
          if (failExit) throw new Error("IPC unavailable");
          active = false;
          return { ok: true };
        },
        activatePreview: async (payload) => {
          activateCalls += 1;
          activatedPayload = payload;
          active = false;
          return { ok: true, previewVersion: 4, bindingVersion: 1 };
        },
      };
      let controller;
      const dispatch = (action) => {
        state = reduceCharacterControl(state, action);
        controller?.render();
      };
      controller = createCharacterPreviewController({
        getState: () => state,
        dispatch,
        getFacade: () => api,
        getElement: (id) => document.getElementById(id),
        refreshBinding: async () => { refreshCalls += 1; },
      });
      controller.render();
      document.querySelector("#characterPreviewBanner [data-action='exit']").click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const failureVisible = Boolean(document.querySelector("#characterPreviewBanner .character-preview-status"));
      const retryEnabled = !document.querySelector("#characterPreviewBanner [data-action='exit']").disabled;
      failExit = false;
      document.querySelector("#characterPreviewBanner [data-action='exit']").click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const exitHidden = document.getElementById("characterPreviewBanner").hidden;
      active = true;
      state = initialCharacterControlState({
        sessionId: "session-preview",
        preview: {
          previewVersion: 7, bindingVersion: 3, character: true, persona: false,
          worldBookCount: 0,
          activation: { receiptId: "receipt-activate", actionToken: "fresh-token" },
          loading: false, conflict: null,
        },
      });
      controller.render();
      document.querySelector("#characterPreviewBanner [data-action='activate']").click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        failureVisible,
        retryEnabled,
        exitCalls,
        loadCalls,
        exitHidden,
        activateCalls,
        refreshCalls,
        activatedPayload,
        bannerHidden: document.getElementById("characterPreviewBanner").hidden,
      };
    })()`);
    if (!result.failureVisible || !result.retryEnabled || result.exitCalls !== 2
      || result.loadCalls !== 3 || !result.exitHidden || result.activateCalls !== 1
      || result.refreshCalls !== 1 || result.activatedPayload?.receiptId !== "receipt-activate"
      || result.activatedPayload?.actionToken !== "fresh-token"
      || result.activatedPayload?.expectedPreviewVersion !== 7
      || result.activatedPayload?.expectedBindingVersion !== 3
      || !result.bannerHidden) {
      throw new Error(`preview controller assertions failed: ${JSON.stringify(result)}`);
    }
    console.log("PASS: test-character-preview-controller");
  } finally {
    win.destroy();
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
