"use strict";

const { dialog, ipcMain } = require("electron");

// Character Worlds IPC boundary (design spec §15/§16, HANDOFF.md §5/§6).
//
// The renderer can never supply owner/account IDs, raw source paths, or
// destination paths as trusted values:
//   - owner scope is derived in the main process for every call
//   - import sources come from a main-process open dialog (payload path fields
//     are ignored by construction)
//   - export destinations come from a main-process save dialog and become an
//     opaque broker reservation before any bytes move
// Errors crossing the bridge are stable codes only — no messages, stacks,
// card bytes beyond the documented preview fields, or local paths.

const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_EVENTS_LIMIT = 200;
const MAX_FILE_STEM_LENGTH = 80;
const PREVIEW_TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const BINDING_MODES = new Set(["native", "character"]);
const DUPLICATE_RESOLUTIONS = new Set(["create_copy"]);
const CARD_TOO_LARGE_CODES = new Set([
  "CARD_TOO_LARGE",
  "CHARACTER_DATA_TOO_LARGE",
  "IMPORT_SOURCE_TOO_LARGE",
  "IMPORT_WORKER_RESULT_TOO_LARGE",
]);
// Renderer-safe error whitelist: only codes from the character-worlds domain
// vocabulary (audited in src/main/character-worlds — every coded throw lives in
// these five families) plus the two host-level codes. Anything else (SQLite
// codes, library errors, future non-domain codes) collapses to
// CHARACTER_WORLDS_UNAVAILABLE so no internal detail crosses the bridge.
const DOMAIN_CODE_PREFIXES = Object.freeze(["CHARACTER_", "IMPORT_", "EXPORT_", "CARD_", "PNG_"]);
const DOMAIN_CODES_EXTRA = new Set([
  "NOT_A_CHARACTER_CARD",
  "OWNER_SCOPE_UNAVAILABLE",
]);
const CARD_DIALOG_FILTERS = [
  { name: "Character Card", extensions: ["json", "png", "apng"] },
];

function failure(code, extra = {}) {
  return { ok: false, error: code, ...extra };
}

function isWhitelistedDomainCode(code) {
  return typeof code === "string"
    && /^[A-Z][A-Z0-9_]{1,71}$/.test(code)
    && (DOMAIN_CODES_EXTRA.has(code)
      || DOMAIN_CODE_PREFIXES.some((prefix) => code.startsWith(prefix)));
}

function mapDomainError(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  if (code === "CHARACTER_BINDING_CONFLICT") {
    return failure("CHARACTER_BINDING_CONFLICT", {
      currentBinding: error?.current ?? null,
    });
  }
  if (code && CARD_TOO_LARGE_CODES.has(code)) return failure("CARD_TOO_LARGE");
  if (isWhitelistedDomainCode(code)) return failure(code);
  return failure("CHARACTER_WORLDS_UNAVAILABLE");
}

// The only trusted sender is this app's own main window webContents, and only
// while it shows local (file:) content. Anything else — guest frames, remote
// URLs, destroyed windows — is rejected before touching domain state.
function isTrustedSender(ctx, event) {
  try {
    const win = ctx?.mainWindow;
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) return false;
    if (!win.webContents || event?.sender !== win.webContents) return false;
    const url = event?.senderFrame?.url;
    if (typeof url === "string" && url && !url.startsWith("file:")) return false;
    return true;
  } catch {
    return false;
  }
}

function boundedPayload(payload) {
  if (payload == null) return {};
  if (typeof payload !== "object" || Array.isArray(payload)) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) return null;
  } catch {
    return null;
  }
  return payload;
}

function validId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && !/[\u0000-\u001f\u007f/\\]/.test(value);
}

function validVersion(value) {
  return Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function safeFileStem(displayName) {
  const stem = String(displayName || "")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "")
    .trim()
    .slice(0, MAX_FILE_STEM_LENGTH);
  return stem || "character-card";
}

function resolveOwnerScope(ctx) {
  try {
    const resolver = typeof ctx?.resolveCharacterOwnerScope === "function"
      ? ctx.resolveCharacterOwnerScope
      : require("./character-worlds/owner-scope").resolveCharacterOwnerScope;
    const owner = resolver();
    return typeof owner === "string" && owner ? owner : null;
  } catch {
    return null;
  }
}

function resolveSessionAuthority(ctx, sessionId) {
  if (!validId(sessionId)) return { error: "INVALID_INPUT" };
  const resolved = ctx?.sessionManager?.resolveTurnOwnerScope?.(sessionId);
  if (!resolved || resolved.ok !== true || typeof resolved.ownerScope !== "string" || !resolved.ownerScope) {
    const code = typeof resolved?.error === "string" && ERROR_CODE_PATTERN.test(resolved.error)
      ? resolved.error
      : "NO_SESSION";
    return { error: code };
  }
  return { sessionId, ownerScope: resolved.ownerScope };
}

function registerCharacterWorldsHandlers(ctx) {
  const service = () => ctx.characterWorldsService || null;
  const repository = () => (
    ctx.characterWorldsRepository || ctx.characterWorldsService?.repository || null
  );

  function guard(event, payload) {
    if (!isTrustedSender(ctx, event)) return failure("UNTRUSTED_SENDER");
    if (boundedPayload(payload) === null) return failure("INVALID_INPUT");
    return null;
  }

  ipcMain.handle("character:list", async (event, payload) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!owner || !repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    try {
      return { ok: true, characters: repo.listCharacters(owner) };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("character:get", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!owner || !repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    if (!validId(payload?.characterId)) return failure("INVALID_INPUT");
    try {
      const character = repo.getCharacter(owner, payload.characterId);
      if (!character) return failure("CHARACTER_NOT_FOUND");
      return { ok: true, character };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("character:import-preview", async (event, payload) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const svc = service();
    const owner = resolveOwnerScope(ctx);
    if (!svc || !owner) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    let picked;
    try {
      picked = await dialog.showOpenDialog(ctx.mainWindow, {
        title: "Import Character Card",
        properties: ["openFile"],
        filters: CARD_DIALOG_FILTERS,
      });
    } catch (error) {
      return mapDomainError(error);
    }
    if (picked?.canceled || !Array.isArray(picked?.filePaths) || !picked.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    try {
      const preview = await svc.previewImport({
        ownerScope: owner,
        sourcePath: picked.filePaths[0],
      });
      if (preview?.ok === false && preview?.kind === "ordinaryAttachment") {
        return failure("NOT_A_CHARACTER_CARD", { fallback: "ordinary_attachment" });
      }
      return preview;
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("character:import-commit", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const svc = service();
    const owner = resolveOwnerScope(ctx);
    if (!svc || !owner) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    if (!PREVIEW_TOKEN_PATTERN.test(payload?.previewToken)) return failure("INVALID_INPUT");
    const duplicateResolution = payload.duplicateResolution;
    if (duplicateResolution != null && !DUPLICATE_RESOLUTIONS.has(duplicateResolution)) {
      return failure("INVALID_INPUT");
    }
    try {
      const committed = await svc.commitImport({
        ownerScope: owner,
        previewToken: payload.previewToken,
        duplicateResolution: duplicateResolution || undefined,
      });
      return { ok: true, ...committed };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("character:export", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const svc = service();
    const owner = resolveOwnerScope(ctx);
    const repo = repository();
    if (!svc || !owner || !repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    if (!validId(payload?.revisionId)) return failure("INVALID_INPUT");
    try {
      const revision = repo.getRevision(owner, payload.revisionId);
      if (!revision) return failure("CHARACTER_REVISION_NOT_FOUND");
      const container = revision.source?.container;
      const extension = container === "apng" ? "apng" : container === "json" ? "json" : "png";
      const picked = await dialog.showSaveDialog(ctx.mainWindow, {
        title: "Export Character Card",
        defaultPath: `${safeFileStem(revision.displayName)}.${extension}`,
        filters: [{ name: "Character Card", extensions: [extension] }],
      });
      if (picked?.canceled || !picked?.filePath) return { ok: false, canceled: true };
      const capability = await svc.destinationWriter.approve(picked.filePath);
      return await svc.exportCharacter({
        ownerScope: owner,
        revisionId: payload.revisionId,
        destinationCapability: capability,
      });
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("session-character:get-binding", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const repo = repository();
    if (!repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const session = resolveSessionAuthority(ctx, payload?.sessionId);
    if (session.error) return failure(session.error);
    try {
      return { ok: true, binding: repo.getBinding(session.sessionId, session.ownerScope) };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("session-character:set-binding", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const repo = repository();
    if (!repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const session = resolveSessionAuthority(ctx, payload?.sessionId);
    if (session.error) return failure(session.error);
    if (!validVersion(payload.expectedBindingVersion)) return failure("INVALID_INPUT");
    if (!BINDING_MODES.has(payload.mode)) return failure("INVALID_INPUT");
    const next = { mode: payload.mode };
    if (payload.mode === "character") {
      if (!validId(payload.characterRevisionId)) return failure("INVALID_INPUT");
      next.characterRevisionId = payload.characterRevisionId;
    }
    try {
      const binding = repo.setBinding({
        sessionId: session.sessionId,
        ownerScope: session.ownerScope,
        expectedBindingVersion: payload.expectedBindingVersion,
        next,
      });
      return { ok: true, binding };
    } catch (error) {
      return mapDomainError(error);
    }
  });

  ipcMain.handle("session-character:get-events", async (event, payload = {}) => {
    const denied = guard(event, payload);
    if (denied) return denied;
    const repo = repository();
    if (!repo) return failure("CHARACTER_WORLDS_UNAVAILABLE");
    const session = resolveSessionAuthority(ctx, payload?.sessionId);
    if (session.error) return failure(session.error);
    const options = {};
    if (payload.afterVersion != null) {
      if (!validVersion(payload.afterVersion)) return failure("INVALID_INPUT");
      options.afterVersion = payload.afterVersion;
    }
    if (payload.limit != null) {
      if (!Number.isInteger(payload.limit) || payload.limit < 1) return failure("INVALID_INPUT");
      options.limit = Math.min(payload.limit, MAX_EVENTS_LIMIT);
    }
    try {
      return {
        ok: true,
        events: repo.getBindingEvents(session.sessionId, session.ownerScope, options),
      };
    } catch (error) {
      return mapDomainError(error);
    }
  });
}

module.exports = { registerCharacterWorldsHandlers };
