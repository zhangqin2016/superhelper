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
    const turnViewUrl = pathToFileURL(path.join(__dirname, "..", "src", "renderer", "modules", "turn-view-renderer.js")).href;
    const result = await win.webContents.executeJavaScript(`(async () => {
      const { renderCharacterResultCard } = await import(${JSON.stringify(cardUrl)});
      const { renderCharacterPreviewBanner } = await import(${JSON.stringify(bannerUrl)});
      const { liveTurnFromRecord, renderSealedTurnArticle } = await import(${JSON.stringify(turnViewUrl)});
      const calls = [];
      const actionSessions = [];
      const api = {
        getReceiptActions: async (sessionId) => {
          actionSessions.push(sessionId);
          return { ok: true, actions: { preview: "p", adjust: "a", view: "v" } };
        },
        getPreview: async () => ({ ok: true, preview: { previewVersion: 0 } }),
        startPreview: async (payload) => { calls.push(payload); return { ok: true, previewVersion: 1 }; },
        adjustTarget: async () => ({ ok: true, authoringContextHandle: "opaque-handle" }),
        getReceiptView: async () => ({ ok: true, kind: "character", entityId: "entity-1", revisionId: "revision-1" }),
      };
      window.assistantClient = { characterWorlds: api };
      let adjusted = null;
      let viewed = null;
      const receiptId = "receipt-secret-id";
      const card = renderCharacterResultCard({
        type: "character_worlds_receipt", schemaVersion: 1, receiptId,
        kind: "character", displayName: "A very long but valid character name",
        revisionNumber: 1, state: "draft", provenance: "agent_draft",
      }, {
        sessionId: "session-a", api,
        onAdjust: (value) => { adjusted = value; },
        onView: (value) => { viewed = value; },
      });
      document.body.append(card);
      card.querySelector("[data-action='preview']").click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      card.querySelector("[data-action='adjust']").click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      card.querySelector("[data-action='view']").click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const sealedTurn = liveTurnFromRecord({
        turnId: "turn-sealed-character-card", terminal: "turn.completed",
        assistantText: "角色已创建", startedAt: 1000, endedAt: 2000,
        resultBlocks: [{
          type: "character_worlds_receipt", schemaVersion: 1, receiptId,
          kind: "character", displayName: "Sealed character", revisionNumber: 1,
          state: "draft", provenance: "agent_draft",
        }],
      });
      const sealedArticle = renderSealedTurnArticle(sealedTurn, false, "session-sealed");
      document.body.append(sealedArticle);
      sealedArticle.querySelector("[data-action='preview']").click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const malformed = renderCharacterResultCard({ type: "character_worlds_receipt", secret: "DO_NOT_RENDER" }, { api });
      const banner = renderCharacterPreviewBanner({ character: true, previewVersion: 1 }, {});
      const inactiveBanner = renderCharacterPreviewBanner({}, {});
      document.body.append(inactiveBanner);
      return {
        previewLabel: card.querySelector("[data-action='preview']").textContent,
        leakedReceipt: card.textContent.includes(receiptId),
        calls: calls.length,
        adjusted,
        viewed,
        actionSessions,
        malformedText: malformed.textContent,
        bannerHidden: banner.hidden,
        bannerActions: banner.querySelectorAll("button").length,
        inactiveBannerDisplay: getComputedStyle(inactiveBanner).display,
      };
    })()`);
    if (!result.previewLabel || result.leakedReceipt || result.calls !== 2
      || result.adjusted?.handle !== "opaque-handle"
      || result.viewed?.revisionId !== "revision-1"
      || result.actionSessions.filter((sessionId) => sessionId === "session-a").length !== 3
      || !result.actionSessions.includes("session-sealed")
      || result.malformedText.includes("DO_NOT_RENDER")
      || result.bannerHidden || result.bannerActions !== 2
      || result.inactiveBannerDisplay !== "none") {
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
