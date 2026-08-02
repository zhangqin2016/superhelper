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
    const cardUrl = pathToFileURL(path.join(__dirname, "..", "src", "renderer", "modules", "character-result-card.js")).href;
    const bannerUrl = pathToFileURL(path.join(__dirname, "..", "src", "renderer", "modules", "character-preview-banner.js")).href;
    const result = await win.webContents.executeJavaScript(`(async () => {
      const { renderCharacterResultCard } = await import(${JSON.stringify(cardUrl)});
      const { renderCharacterPreviewBanner } = await import(${JSON.stringify(bannerUrl)});
      const calls = [];
      const api = {
        getReceiptActions: async () => ({ ok: true, actions: { preview: "p", adjust: "a", view: "v" } }),
        getPreview: async () => ({ ok: true, preview: { previewVersion: 0 } }),
        startPreview: async (payload) => { calls.push(payload); return { ok: true, previewVersion: 1 }; },
        adjustTarget: async () => ({ ok: true, authoringContextHandle: "opaque-handle" }),
      };
      let adjusted = null;
      const receiptId = "receipt-secret-id";
      const card = renderCharacterResultCard({
        type: "character_worlds_receipt", schemaVersion: 1, receiptId,
        kind: "character", displayName: "A very long but valid character name",
        revisionNumber: 1, state: "draft", provenance: "agent_draft",
      }, { sessionId: "session-a", api, onAdjust: (value) => { adjusted = value; } });
      document.body.append(card);
      card.querySelector("[data-action='preview']").click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      card.querySelector("[data-action='adjust']").click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const malformed = renderCharacterResultCard({ type: "character_worlds_receipt", secret: "DO_NOT_RENDER" }, { api });
      const banner = renderCharacterPreviewBanner({ character: true, previewVersion: 1 }, {});
      return {
        previewLabel: card.querySelector("[data-action='preview']").textContent,
        leakedReceipt: card.textContent.includes(receiptId),
        calls: calls.length,
        adjusted,
        malformedText: malformed.textContent,
        bannerHidden: banner.hidden,
        bannerActions: banner.querySelectorAll("button").length,
      };
    })()`);
    if (!result.previewLabel || result.leakedReceipt || result.calls !== 1
      || result.adjusted?.handle !== "opaque-handle"
      || result.malformedText.includes("DO_NOT_RENDER")
      || result.bannerHidden || result.bannerActions !== 2) {
      throw new Error(`renderer assertions failed: ${JSON.stringify(result)}`);
    }
    console.log("PASS: test-character-result-card");
  } finally {
    win.destroy();
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
