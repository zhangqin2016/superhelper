#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);
const handlers = new Map();
const trustedWebContents = { id: 71 };
const mainWindow = { webContents: trustedWebContents, isDestroyed: () => false };
const electronMock = {
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
  dialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
};
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === "electron") return electronMock;
  return originalLoad.call(this, request, parent, isMain);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-experience-ipc-"));
const { MessageStore } = require("../src/main/store/message-store.js");
const { DraftReceiptBuilder } = require("../src/main/character-worlds/draft-receipt.js");
const { registerCharacterWorldsHandlers } = require("../src/main/ipc-character-worlds.js");
const store = new MessageStore(path.join(tmp, "messages.db"), path.join(tmp, "blobs"));
const repository = store.characterWorlds();
const OWNER = "profile:experience-ipc";
const sessions = new Set(["session-a", "session-b"]);
const ctx = {
  mainWindow,
  characterWorldsRepository: repository,
  resolveCharacterOwnerScope: () => OWNER,
  characterWorldsPolicy: () => ({ enabled: true }),
  sessionManager: {
    resolveTurnOwnerScope(sessionId) {
      return sessions.has(sessionId)
        ? { ok: true, ownerScope: OWNER }
        : { ok: false, error: "NO_SESSION" };
    },
  },
};

function invoke(channel, payload, sender = trustedWebContents) {
  return handlers.get(channel)({ sender, senderFrame: { url: "file:///app/index.html" } }, payload);
}

try {
  registerCharacterWorldsHandlers(ctx);
  const created = repository.createCharacter({
    ownerScope: OWNER,
    canonical: { name: "Aria", description: "A careful companion." },
    source: { kind: "agent_draft", format: "lily", container: "json" },
  });
  const block = new DraftReceiptBuilder({ repository }).create({
    ownerScope: OWNER,
    sessionId: "session-a",
    turnId: "turn-1",
    evidence: {
      name: "lily_character_draft",
      callId: "call-1",
      input: { action: "create", kind: "character", entityId: "", expectedBaseRevisionId: "" },
      result: { ok: true, entityId: created.entity.id, revisionId: created.revision.id, revisionNumber: 1 },
    },
  });

  const offered = await invoke("character-worlds:receipt-actions", {
    sessionId: "session-a", receiptId: block.receiptId,
  });
  assert.equal(offered.ok, true);
  for (const token of Object.values(offered.actions)) assert.match(token, /^[A-Za-z0-9_-]{43}$/);

  const forbidden = await invoke("character-worlds:preview-start", {
    sessionId: "session-b", receiptId: block.receiptId,
    actionToken: offered.actions.preview, expectedPreviewVersion: 0,
  });
  assert.equal(forbidden.ok, false);

  const started = await invoke("character-worlds:preview-start", {
    sessionId: "session-a", receiptId: block.receiptId,
    actionToken: offered.actions.preview, expectedPreviewVersion: 0,
  });
  assert.deepEqual(started, { ok: true, previewVersion: 1 });
  const state = await invoke("character-worlds:preview-get", { sessionId: "session-a" });
  assert.deepEqual({ ...state.preview, activation: Boolean(state.preview.activation) }, {
    previewVersion: 1, bindingVersion: 0, character: true, persona: false,
    worldBookCount: 0, activation: true,
  });

  const conflictActions = await invoke("character-worlds:receipt-actions", {
    sessionId: "session-a", receiptId: block.receiptId,
  });
  const conflict = await invoke("character-worlds:preview-activate", {
    sessionId: "session-a", receiptId: block.receiptId,
    actionToken: conflictActions.actions.activate,
    expectedPreviewVersion: 1, expectedBindingVersion: 99,
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "CHARACTER_BINDING_CONFLICT");

  const fresh = await invoke("character-worlds:receipt-actions", {
    sessionId: "session-a", receiptId: block.receiptId,
  });
  const activated = await invoke("character-worlds:preview-activate", {
    sessionId: "session-a", receiptId: block.receiptId,
    actionToken: fresh.actions.activate,
    expectedPreviewVersion: 1, expectedBindingVersion: 0,
  });
  assert.deepEqual(activated, { ok: true, previewVersion: 2, bindingVersion: 1 });
  assert.equal(repository.getBinding("session-a", OWNER).characterRevisionId, created.revision.id);

  const exited = await invoke("character-worlds:preview-exit", {
    sessionId: "session-a", expectedPreviewVersion: 2,
  });
  assert.deepEqual(exited, { ok: true, previewVersion: 3 });

  const untrusted = await invoke("character-worlds:preview-get", { sessionId: "session-a" }, { id: 999 });
  assert.equal(untrusted.error, "UNTRUSTED_SENDER");
  console.log("PASS: test-character-worlds-experience-ipc");
} finally {
  Module._load = originalLoad;
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
