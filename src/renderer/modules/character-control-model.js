/**
 * Pure, session-scoped state model for the conversation character control
 * (Character Worlds Phase 1). No IPC, DOM, or timers — stale async responses
 * (wrong sessionId or superseded seq) are dropped so rapid session switching
 * can never cross-bind a conversation. Fail-open: corrupt bindings and
 * unavailable features always read as native Lily (design spec §16).
 */

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

export function initialCharacterControlState(overrides = {}) {
  return {
    sessionId: null,
    available: true,
    mode: "native",
    bindingVersion: 0,
    characterRevisionId: null,
    compatibilityProfile: null,
    characterName: "",
    characters: [],
    loadSeq: 0,
    selecting: false,
    notice: null,
    importPreview: null,
    importCommitting: false,
    ...overrides,
  };
}

/** Effective conversation mode: an unavailable feature always reads native. */
export function effectiveCharacterMode(state) {
  return state?.available === false ? "native" : state?.mode || "native";
}

function normalizeBinding(binding) {
  const version = Number.isInteger(binding?.bindingVersion) && binding.bindingVersion >= 0
    ? binding.bindingVersion
    : 0;
  const revisionId = typeof binding?.characterRevisionId === "string" && binding.characterRevisionId
    ? binding.characterRevisionId
    : null;
  const profile = typeof binding?.compatibilityProfile === "string" ? binding.compatibilityProfile : null;
  if (binding?.mode === "character" && revisionId) {
    return { mode: "character", bindingVersion: version, characterRevisionId: revisionId, compatibilityProfile: profile, recovered: false };
  }
  // Native, or a corrupt character binding failing open to native (the binding
  // version is preserved so a later recovery can resume from it).
  return { mode: "native", bindingVersion: version, characterRevisionId: null, compatibilityProfile: null, recovered: true };
}

function sanitizeCharacters(characters) {
  if (!Array.isArray(characters)) return [];
  return characters
    .map((c) => ({
      id: typeof c?.id === "string" ? c.id : "",
      displayName: typeof c?.displayName === "string" ? c.displayName : "",
      currentRevisionId: typeof c?.currentRevisionId === "string" ? c.currentRevisionId : "",
    }))
    .filter((c) => c.id && c.currentRevisionId);
}

function nameForRevision(characters, revisionId) {
  const found = (characters || []).find((c) => c.currentRevisionId === revisionId);
  return found?.displayName || "";
}

function upsertCharacter(characters, character) {
  const [sanitized] = sanitizeCharacters([character]);
  if (!sanitized) return characters;
  const rest = characters.filter((c) => c.id !== sanitized.id);
  return [sanitized, ...rest];
}

function normalizePreview(preview) {
  const compat = preview?.compatibility || {};
  const counts = compat.counts || {};
  const countOf = (key) => Number.isInteger(counts[key])
    ? counts[key]
    : (Array.isArray(compat[key]) ? compat[key].length : 0);
  const rejected = countOf("rejectedExecutable");
  const warnings = (Array.isArray(compat.warnings) ? compat.warnings : [])
    .filter((w) => w && typeof w.code === "string")
    .map((w) => ({ code: w.code }));
  if (rejected > 0 && !warnings.some((w) => w.code === "EXECUTABLE_REJECTED")) {
    warnings.unshift({ code: "EXECUTABLE_REJECTED" });
  }
  return {
    previewToken: typeof preview?.previewToken === "string" ? preview.previewToken : "",
    name: typeof preview?.canonical?.name === "string" ? preview.canonical.name : "",
    format: typeof preview?.format === "string" ? preview.format : "",
    container: typeof preview?.container === "string" ? preview.container : "json",
    level: typeof compat.level === "string" ? compat.level : "lossless_data",
    supportedCount: countOf("supported"),
    inertCount: countOf("preservedInert"),
    duplicateKind: preview?.duplicates?.exact ? "exact" : (preview?.duplicates?.canonical ? "canonical" : null),
    warnings,
  };
}

/**
 * Stale-response guard shared by every async outcome action: an action pinned
 * to a sessionId/seq that no longer matches is dropped, so a slow IPC reply
 * can never paint one conversation's character state onto another.
 */
function isStale(state, action) {
  if (action.sessionId != null && state.sessionId && action.sessionId !== state.sessionId) return true;
  if (action.seq != null && action.seq !== state.loadSeq) return true;
  return false;
}

export function reduceCharacterControl(state, action) {
  switch (action?.type) {
    case "session.changed": {
      if (action.sessionId === state.sessionId) {
        // Same-session re-entry bumps the seq to invalidate in-flight loads.
        return action.sessionId ? { ...state, loadSeq: state.loadSeq + 1 } : state;
      }
      // Session switch (or the active session going away): reset the
      // conversation-scoped view; the character library and feature
      // availability are owner-scoped and carry over.
      return {
        ...initialCharacterControlState(),
        sessionId: action.sessionId || null,
        available: state.available,
        characters: state.characters,
        loadSeq: state.loadSeq + 1,
      };
    }
    case "binding.loaded": {
      if (isStale(state, action)) return state;
      const b = normalizeBinding(action.binding);
      const next = {
        ...state,
        sessionId: state.sessionId || action.sessionId || null,
        mode: b.mode,
        bindingVersion: b.bindingVersion,
        characterRevisionId: b.characterRevisionId,
        compatibilityProfile: b.compatibilityProfile,
        characterName: b.characterRevisionId
          ? (state.characterRevisionId === b.characterRevisionId && state.characterName)
            || nameForRevision(state.characters, b.characterRevisionId)
          : "",
        selecting: false,
        notice: null,
      };
      if (b.recovered && action.binding?.mode === "character") next.notice = "binding_fallback";
      return next;
    }
    case "binding.loadFailed": {
      if (isStale(state, action)) return state;
      // Feature unavailable (kill switch / policy): the VIEW returns to native
      // while the stored binding is preserved (spec §16). A transient load
      // failure keeps the last known state instead of yo-yoing the UI.
      if (action.error === "CHARACTER_WORLDS_UNAVAILABLE") {
        return { ...state, available: false, selecting: false, notice: "unavailable" };
      }
      return { ...state, selecting: false };
    }
    case "binding.conflict": {
      if (isStale(state, action)) return state;
      const b = normalizeBinding(action.currentBinding);
      return {
        ...state,
        mode: b.mode,
        bindingVersion: b.bindingVersion,
        characterRevisionId: b.characterRevisionId,
        compatibilityProfile: b.compatibilityProfile,
        characterName: b.characterRevisionId
          ? nameForRevision(state.characters, b.characterRevisionId)
          : "",
        selecting: false,
        notice: "conflict",
      };
    }
    case "characters.loaded": {
      const characters = sanitizeCharacters(action.characters);
      const next = { ...state, characters };
      if (state.characterRevisionId) {
        next.characterName = nameForRevision(characters, state.characterRevisionId) || state.characterName;
      }
      return next;
    }
    case "selection.started": {
      const mode = action.mode === "character" && action.characterRevisionId ? "character" : "native";
      return {
        ...state,
        mode,
        characterRevisionId: mode === "character" ? action.characterRevisionId : null,
        characterName: mode === "character" ? String(action.characterName || "") : "",
        selecting: true,
        notice: null,
      };
    }
    case "selection.settled": {
      if (isStale(state, action)) return state;
      const b = normalizeBinding(action.binding);
      return {
        ...state,
        mode: b.mode,
        bindingVersion: b.bindingVersion,
        characterRevisionId: b.characterRevisionId,
        compatibilityProfile: b.compatibilityProfile,
        selecting: false,
      };
    }
    case "selection.failed":
      if (isStale(state, action)) return state;
      return { ...state, selecting: false, notice: "unavailable" };
    case "availability.set":
      return action.available
        ? { ...state, available: true }
        : { ...state, available: false, notice: "unavailable" };
    case "import.previewLoaded":
      // Pin the originating session so a commit finishing after a session
      // switch can complete the import without auto-selecting into the wrong
      // conversation.
      return {
        ...state,
        importPreview: { ...normalizePreview(action.preview), sessionId: state.sessionId || null },
        notice: null,
      };
    case "import.previewFailed": {
      const error = action.error;
      const notice = error === "NOT_A_CHARACTER_CARD"
        ? "ordinary_attachment"
        : error === "CARD_TOO_LARGE"
          ? "import_too_large"
          : error === "CHARACTER_WORLDS_UNAVAILABLE"
            ? "unavailable"
            : "import_failed";
      return { ...state, importPreview: null, importCommitting: false, notice };
    }
    case "import.dismissed":
      return { ...state, importPreview: null, importCommitting: false };
    case "import.commitStarted":
      return state.importPreview ? { ...state, importCommitting: true } : state;
    case "import.committed":
      return {
        ...state,
        importPreview: null,
        importCommitting: false,
        characters: upsertCharacter(state.characters, action.character),
      };
    case "import.commitFailed":
      return action.error === "IMPORT_PREVIEW_EXPIRED"
        ? { ...state, importPreview: null, importCommitting: false, notice: "import_expired" }
        : { ...state, importCommitting: false, notice: "import_failed" };
    case "notice.dismissed":
      return state.notice ? { ...state, notice: null } : state;
    default:
      return state;
  }
}

