"use strict";

// Shared Character Worlds IPC boundary guards (design spec §15/§16). Extracted
// so the discipline — trusted sender, payload bounds, owner derivation, error
// whitelist, rollout policy gate — exists in exactly one place for both
// ipc-character-worlds.js (Phase 1/2A/2B-2 channels) and
// ipc-character-authoring.js (Phase 2B authoring channels).

const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_ID_LENGTH = 128;
// Renderer-safe error whitelist: only codes from the character-worlds domain
// vocabulary (audited in src/main/character-worlds — every coded throw lives in
// these six families) plus the two host-level codes. Anything else (SQLite
// codes, library errors, future non-domain codes) collapses to
// CHARACTER_WORLDS_UNAVAILABLE so no internal detail crosses the bridge.
const CARD_TOO_LARGE_CODES = new Set([
  "CARD_TOO_LARGE",
  "CHARACTER_DATA_TOO_LARGE",
  "IMPORT_SOURCE_TOO_LARGE",
  "IMPORT_WORKER_RESULT_TOO_LARGE",
]);
const DOMAIN_CODE_PREFIXES = Object.freeze([
  "CHARACTER_", "IMPORT_", "EXPORT_", "CARD_", "PNG_", "WORLD_BOOK_",
  "PERSONA_",
]);
const DOMAIN_CODES_EXTRA = new Set([
  "NOT_A_CHARACTER_CARD",
  "OWNER_SCOPE_UNAVAILABLE",
]);

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

function boundedPayload(payload, maxBytes = MAX_PAYLOAD_BYTES) {
  if (payload == null) return {};
  if (typeof payload !== "object" || Array.isArray(payload)) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > maxBytes) return null;
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

// Rollout policy gate (design spec §16/§18): an unsigned/stale/disabled
// remote policy — or the LILY_CHARACTER_WORLDS=0 kill switch — disables
// selection and import only. Stored cards, bindings, events, and exports stay
// readable regardless. Any resolution failure fails closed.
function characterWorldsPolicyFor(ctx) {
  try {
    if (typeof ctx?.characterWorldsPolicy === "function") return ctx.characterWorldsPolicy();
    const { characterWorldsPolicy } = require("./character-worlds/constants");
    return characterWorldsPolicy(require("./remote-config").getRemoteEffectiveConfigSync());
  } catch {
    return { enabled: false, reason: "policy_error" };
  }
}

function policyDeniesSelection(ctx) {
  const policy = characterWorldsPolicyFor(ctx);
  return policy?.enabled === true ? null : failure("CHARACTER_WORLDS_UNAVAILABLE");
}

module.exports = {
  MAX_PAYLOAD_BYTES,
  MAX_ID_LENGTH,
  failure,
  mapDomainError,
  isTrustedSender,
  boundedPayload,
  validId,
  resolveOwnerScope,
  characterWorldsPolicyFor,
  policyDeniesSelection,
};
