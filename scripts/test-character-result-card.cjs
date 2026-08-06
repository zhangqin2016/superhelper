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
      const failingCard = renderCharacterResultCard({
        type: "character_worlds_receipt", schemaVersion: 1, receiptId: "failed-receipt",
        kind: "character", displayName: "Failed action", revisionNumber: 1,
        state: "draft", provenance: "agent_draft",
      }, {
        sessionId: "session-failed",
        api: { getReceiptActions: async () => ({ ok: false, error: "unavailable" }) },
      });
      document.body.append(failingCard);
      failingCard.querySelector("[data-action='view']").click();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const missingApiCard = renderCharacterResultCard({
        type: "character_worlds_receipt", schemaVersion: 1, receiptId: "missing-api-receipt",
        kind: "character", displayName: "Missing API", revisionNumber: 1,
        state: "draft", provenance: "agent_draft",
      }, { sessionId: "session-missing", api: null });
      document.body.append(missingApiCard);
      missingApiCard.querySelector("[data-action='preview']").click();
      const banner = renderCharacterPreviewBanner({ character: true, previewVersion: 1 }, {});
      let bannerExitCalls = 0;
      const interactiveBanner = renderCharacterPreviewBanner({ character: true, previewVersion: 1 }, {
        onExit: () => { bannerExitCalls += 1; },
      });
      const bannerHost = document.getElementById("characterPreviewBanner");
      bannerHost.replaceChildren(...interactiveBanner.childNodes);
      bannerHost.className = interactiveBanner.className;
      bannerHost.hidden = false;
      const coveringSession = document.createElement("div");
      coveringSession.className = "session-messages is-active";
      document.getElementById("sessionMessagesStack").append(coveringSession);
      const exitButton = bannerHost.querySelector("[data-action='exit']");
      const exitRect = exitButton.getBoundingClientRect();
      const hitTarget = document.elementFromPoint(exitRect.left + exitRect.width / 2, exitRect.top + exitRect.height / 2);
      hitTarget?.click();
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
        failingCardStatus: failingCard.querySelector(".character-result-status").textContent,
        failingCardRetryEnabled: !failingCard.querySelector("[data-action='view']").disabled,
        missingApiStatus: missingApiCard.querySelector(".character-result-status").textContent,
        bannerHidden: banner.hidden,
        bannerActions: banner.querySelectorAll("button").length,
        bannerHitAction: hitTarget?.dataset?.action || "",
        bannerExitCalls,
        coveredSessionPaddingTop: getComputedStyle(coveringSession).paddingTop,
        inactiveBannerDisplay: getComputedStyle(inactiveBanner).display,
      };
    })()`);
    if (!result.previewLabel || result.leakedReceipt || result.calls !== 2
      || result.adjusted?.handle !== "opaque-handle"
      || result.viewed?.revisionId !== "revision-1"
      || result.actionSessions.filter((sessionId) => sessionId === "session-a").length !== 3
      || !result.actionSessions.includes("session-sealed")
      || result.malformedText.includes("DO_NOT_RENDER")
      || !result.failingCardStatus || !result.failingCardRetryEnabled
      || !result.missingApiStatus
      || result.bannerHidden || result.bannerActions !== 2
      || result.bannerHitAction !== "exit" || result.bannerExitCalls !== 1
      || parseFloat(result.coveredSessionPaddingTop) < 46
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
