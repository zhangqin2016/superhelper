"use strict";

const { CharacterPreviewStore } = require("./preview-store");
const { CharacterWorldsReceiptStore } = require("./receipt-store");
const { ReceiptActionBroker } = require("./receipt-actions");
const { buildLibraryActivationConfig } = require("./library-activation");

const LIBRARY_ACTIVATION_KINDS = new Set(["character", "persona", "worldBook"]);

function validLibraryActivationId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

function registerCharacterWorldsExperienceHandlers({ ipcMain, ctx, guard, failure, mapDomainError, policyDeniesSelection, resolveSessionAuthority, repository }) {
  const actions = new ReceiptActionBroker();
  ctx.characterWorldsActionBroker = actions;

  function scope(event, payload) {
    const denied = guard(event, payload);
    if (denied) return { denied };
    const session = resolveSessionAuthority(ctx, payload?.sessionId);
    if (session.error) return { denied: failure(session.error) };
    const repo = repository();
    if (!repo) return { denied: failure("CHARACTER_WORLDS_UNAVAILABLE") };
    return {
      session,
      repo,
      receipts: new CharacterWorldsReceiptStore({ repository: repo }),
      previews: new CharacterPreviewStore({ repository: repo }),
    };
  }

  function receiptOf(resolved, receiptId) {
    return resolved.receipts.get(
      resolved.session.ownerScope, resolved.session.sessionId, receiptId,
    );
  }

  ipcMain.handle("character-worlds:receipt-actions", async (event, payload = {}) => {
    const resolved = scope(event, payload);
    if (resolved.denied) return resolved.denied;
    const receipt = receiptOf(resolved, payload.receiptId);
    if (!receipt) return failure("CHARACTER_RECEIPT_NOT_FOUND");
    const issue = (action) => actions.issue({
      ownerScope: resolved.session.ownerScope,
      sessionId: resolved.session.sessionId,
      receiptId: receipt.id,
      action,
    });
    return { ok: true, actions: {
      preview: issue("preview"), activate: issue("activate"),
      adjust: issue("adjust"), view: issue("view"),
    } };
  });

  ipcMain.handle("character-worlds:receipt-view", async (event, payload = {}) => {
    const resolved = scope(event, payload);
    if (resolved.denied) return resolved.denied;
    const receipt = receiptOf(resolved, payload.receiptId);
    if (!receipt || !actions.consume({
      token: payload.actionToken,
      ownerScope: resolved.session.ownerScope,
      sessionId: resolved.session.sessionId,
      receiptId: payload.receiptId,
      action: "view",
    })) return failure("CHARACTER_ACTION_FORBIDDEN");
    return {
      ok: true,
      kind: receipt.kind,
      entityId: receipt.entityId,
      revisionId: receipt.revisionId,
    };
  });

  ipcMain.handle("character-worlds:preview-get", async (event, payload = {}) => {
    const resolved = scope(event, payload);
    if (resolved.denied) return resolved.denied;
    try {
      const preview = resolved.previews.get(
        resolved.session.ownerScope, resolved.session.sessionId,
      );
      const config = resolved.repo.getConversationConfig(
        resolved.session.sessionId, resolved.session.ownerScope,
      );
      const revisionId = preview?.character?.revisionId
        || preview?.persona?.revisionId
        || preview?.worldBooks?.[0]?.revisionId
        || null;
      const receipt = revisionId ? resolved.receipts.getLatestByRevision(
        resolved.session.ownerScope, resolved.session.sessionId, revisionId,
      ) : null;
      return { ok: true, preview: {
        previewVersion: preview?.previewVersion || 0,
        bindingVersion: config.bindingVersion,
        character: Boolean(preview?.character),
        persona: Boolean(preview?.persona),
        worldBookCount: preview?.worldBooks?.length || 0,
        activation: receipt ? {
          receiptId: receipt.id,
          actionToken: actions.issue({
            ownerScope: resolved.session.ownerScope,
            sessionId: resolved.session.sessionId,
            receiptId: receipt.id,
            action: "activate",
          }),
        } : null,
      } };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("character-worlds:preview-start", async (event, payload = {}) => {
    const resolved = scope(event, payload);
    if (resolved.denied) return resolved.denied;
    const receipt = receiptOf(resolved, payload.receiptId);
    if (!receipt || !actions.consume({
      token: payload.actionToken,
      ownerScope: resolved.session.ownerScope,
      sessionId: resolved.session.sessionId,
      receiptId: payload.receiptId,
      action: "preview",
    })) return failure("CHARACTER_ACTION_FORBIDDEN");
    try {
      const common = {
        ownerScope: resolved.session.ownerScope,
        sessionId: resolved.session.sessionId,
        expectedPreviewVersion: payload.expectedPreviewVersion,
        revisionId: receipt.revisionId,
      };
      const preview = receipt.kind === "worldBook"
        ? resolved.previews.addWorldBook({ ...common, scope: "chat", mergeStrategy: "constant" })
        : resolved.previews.replaceFacet({ ...common, facet: receipt.kind });
      return { ok: true, previewVersion: preview.previewVersion };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("character-worlds:preview-exit", async (event, payload = {}) => {
    const resolved = scope(event, payload);
    if (resolved.denied) return resolved.denied;
    try {
      const preview = resolved.previews.clear({
        ownerScope: resolved.session.ownerScope,
        sessionId: resolved.session.sessionId,
        expectedPreviewVersion: payload.expectedPreviewVersion,
      });
      return { ok: true, previewVersion: preview.previewVersion };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("character-worlds:preview-activate", async (event, payload = {}) => {
    const resolved = scope(event, payload);
    if (resolved.denied) return resolved.denied;
    const receipt = receiptOf(resolved, payload.receiptId);
    if (!receipt || !actions.consume({
      token: payload.actionToken,
      ownerScope: resolved.session.ownerScope,
      sessionId: resolved.session.sessionId,
      receiptId: payload.receiptId,
      action: "activate",
    })) return failure("CHARACTER_ACTION_FORBIDDEN");
    try {
      const activated = resolved.previews.activateFacet({
        ownerScope: resolved.session.ownerScope,
        sessionId: resolved.session.sessionId,
        expectedPreviewVersion: payload.expectedPreviewVersion,
        expectedBindingVersion: payload.expectedBindingVersion,
        facet: receipt.kind === "worldBook" ? "worldBook" : receipt.kind,
        entityId: receipt.entityId,
      });
      return { ok: true,
        previewVersion: activated.preview.previewVersion,
        bindingVersion: activated.binding.bindingVersion,
      };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  // Library activation is a direct, explicit user action. It still resolves
  // session ownership in main, verifies the revision belongs to that owner,
  // and commits through the same binding-version CAS as preview activation.
  ipcMain.handle("character-worlds:library-activate", async (event, payload = {}) => {
    const resolved = scope(event, payload);
    if (resolved.denied) return resolved.denied;
    if (!LIBRARY_ACTIVATION_KINDS.has(payload?.kind) || !validLibraryActivationId(payload?.revisionId)) {
      return failure("INVALID_INPUT");
    }
    const action = payload?.action === "remove" ? "remove" : "activate";
    if (!Number.isInteger(payload?.expectedBindingVersion) || payload.expectedBindingVersion < 0) {
      return failure("INVALID_INPUT");
    }
    if (policyDeniesSelection(ctx)) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    try {
      if (action === "activate" && payload.kind === "character" && !resolved.repo.getRevision(
        resolved.session.ownerScope, payload.revisionId,
      )) return failure("CHARACTER_REVISION_NOT_FOUND");
      if (action === "activate" && payload.kind === "persona" && !resolved.repo.getPersonaRevision(
        resolved.session.ownerScope, payload.revisionId,
      )) return failure("PERSONA_REVISION_NOT_FOUND");
      if (action === "activate" && payload.kind === "worldBook" && !resolved.repo.getWorldBookRevision(
        resolved.session.ownerScope, payload.revisionId,
      )) return failure("WORLD_BOOK_REVISION_NOT_FOUND");

      const current = resolved.repo.getConversationConfig(
        resolved.session.sessionId, resolved.session.ownerScope,
      );
      const next = buildLibraryActivationConfig(current, {
        kind: payload.kind,
        revisionId: payload.revisionId,
        action,
        scope: payload.scope,
        mergeStrategy: payload.mergeStrategy,
      });
      const binding = resolved.repo.setConversationConfig({
        sessionId: resolved.session.sessionId,
        ownerScope: resolved.session.ownerScope,
        expectedBindingVersion: payload.expectedBindingVersion,
        next,
      });
      const { books, sceneId, groupId, ...legacyBinding } = binding;
      return { ok: true, binding: legacyBinding };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("character-worlds:adjust-target", async (event, payload = {}) => {
    const resolved = scope(event, payload);
    if (resolved.denied) return resolved.denied;
    const receipt = receiptOf(resolved, payload.receiptId);
    if (!receipt || !actions.consume({
      token: payload.actionToken,
      ownerScope: resolved.session.ownerScope,
      sessionId: resolved.session.sessionId,
      receiptId: payload.receiptId,
      action: "adjust",
    })) return failure("CHARACTER_ACTION_FORBIDDEN");
    return { ok: true, authoringContextHandle: actions.issue({
      ownerScope: resolved.session.ownerScope,
      sessionId: resolved.session.sessionId,
      receiptId: receipt.id,
      action: "authoring",
    }) };
  });
}

module.exports = { registerCharacterWorldsExperienceHandlers };
