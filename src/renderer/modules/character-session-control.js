/**
 * Conversation-level character control (Character Worlds Phase 1).
 *
 * A compact composer-toolbar control that binds the ACTIVE conversation to a
 * local character or back to native Lily. The pure session-scoped model lives
 * in ./character-control-model.js (re-exported here for tests); this module
 * wires the narrow preload facade with optimistic selection +
 * expectedBindingVersion CAS, reconciles conflicts from the server's
 * currentBinding, and fails open: any IPC failure leaves the session in
 * native Lily with a quiet notice (design spec §16, HANDOFF.md §5).
 */

import { $, el } from "./dom.js";
import store from "./state.js";
import { t } from "../i18n/index.js";
import {
  initialCharacterControlState,
  reduceCharacterControl,
  effectiveCharacterMode,
} from "./character-control-model.js";
import { monogram, renderCharacterImportPreview } from "./character-import-preview.js";
import { openCharacterLibrary } from "./character-library.js";

export {
  initialCharacterControlState,
  reduceCharacterControl,
  effectiveCharacterMode,
};

// ---------------------------------------------------------------------------
// Controller (DOM + facade wiring)
// ---------------------------------------------------------------------------

let controlState = initialCharacterControlState();

/** Test/inspection hook: the current session-scoped control state. */
export function getCharacterControlState() {
  return controlState;
}

const USER_ROUND_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>';
const MAX_LISTED_CHARACTERS = 8;

const facade = () => window.assistantClient?.characterWorlds || null;
const btn = () => $("sessionCharacterBtn");
const popover = () => $("characterPopover");

function announce(text) {
  const live = $("characterControlLive");
  if (live && text) live.textContent = text;
}

function noticeText(notice) {
  const keys = {
    unavailable: "character.status.unavailable",
    ordinary_attachment: "character.status.ordinaryAttachment",
    binding_fallback: "character.status.bindingFallback",
    conflict: "character.status.conflict",
    import_failed: "character.import.failed",
    import_too_large: "character.import.tooLarge",
    import_expired: "character.import.expired",
  };
  return keys[notice] ? t(keys[notice]) : "";
}

function dispatch(action) {
  const prev = controlState;
  controlState = reduceCharacterControl(prev, action);
  if (controlState.notice && controlState.notice !== prev.notice) {
    announce(noticeText(controlState.notice));
  }
  render();
  // Focus handoff: when the import preview opens, land on the commit command.
  if (!prev.importPreview && controlState.importPreview) {
    $("characterImportCommitBtn")?.focus();
  }
}

function focusableItems() {
  const p = popover();
  return p && !p.hidden
    ? [...p.querySelectorAll("button:not([disabled])")].filter((b) => !b.closest("[hidden]"))
    : [];
}

function closePopover({ focusButton = false } = {}) {
  const p = popover();
  const b = btn();
  if (!p || p.hidden) return;
  p.hidden = true;
  if (b) {
    b.setAttribute("aria-expanded", "false");
    b.classList.remove("is-open");
    if (focusButton) b.focus();
  }
  if (controlState.importPreview && !controlState.importCommitting) {
    dispatch({ type: "import.dismissed" });
  }
}

function openPopover() {
  const p = popover();
  const b = btn();
  if (!p || !b) return;
  p.hidden = false;
  b.setAttribute("aria-expanded", "true");
  b.classList.add("is-open");
  const composer = $("composer");
  if (composer) {
    const btnRect = b.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    // Inline-start anchoring keeps the popover mirrored correctly in RTL.
    p.style.insetInlineStart = "8px";
    p.style.width = `${Math.min(360, Math.max(0, composerRect.width - 16))}px`;
    p.style.bottom = `${composerRect.bottom - btnRect.top + 8}px`;
  }
  void loadCharacters();
  renderPopover();
  focusableItems()[0]?.focus();
}

function optionRow({ mode, character, checked }) {
  const row = el("button", "character-option", {
    type: "button",
    role: "menuitemradio",
    "aria-checked": checked ? "true" : "false",
  });
  if (mode === "native") {
    row.dataset.characterMode = "native";
    row.appendChild(el("span", "character-option-icon", { innerHTML: USER_ROUND_SVG }));
    row.appendChild(el("span", "character-option-name", { textContent: t("character.nativeOption") }));
  } else {
    row.dataset.characterRevisionId = character.currentRevisionId;
    const swatch = el("span", "character-option-swatch", { textContent: monogram(character.displayName) });
    swatch.setAttribute("aria-hidden", "true");
    row.appendChild(swatch);
    const name = character.displayName || t("character.unnamed");
    row.appendChild(el("span", "character-option-name", { textContent: name, title: name }));
  }
  row.appendChild(el("span", "character-option-check", { textContent: "✓" }));
  return row;
}

function renderList() {
  const list = $("characterList");
  if (!list) return;
  // Rebuilding wipes the DOM; remember the focused row's stable key so focus
  // (and with it the keyboard trap) survives the re-render.
  const active = document.activeElement;
  const focusKey = active && list.contains(active)
    ? active.dataset?.characterMode
      ? `mode:${active.dataset.characterMode}`
      : active.dataset?.characterRevisionId
        ? `rev:${active.dataset.characterRevisionId}`
        : null
    : null;
  list.textContent = "";
  const isCharacter = effectiveCharacterMode(controlState) === "character" && controlState.characterRevisionId;
  list.appendChild(optionRow({ mode: "native", checked: !isCharacter }));
  const characters = controlState.characters.slice(0, MAX_LISTED_CHARACTERS);
  if (!characters.length) {
    list.appendChild(el("div", "character-list-empty", { textContent: t("character.emptyLibrary") }));
  } else {
    list.appendChild(el("div", "character-list-heading", { textContent: t("character.recentHeading") }));
    for (const character of characters) {
      list.appendChild(optionRow({
        character,
        checked: controlState.characterRevisionId === character.currentRevisionId,
      }));
    }
  }
  if (focusKey && !list.contains(document.activeElement)) {
    const selector = focusKey.startsWith("mode:")
      ? `[data-character-mode="${focusKey.slice(5)}"]`
      : `[data-character-revision-id="${CSS.escape(focusKey.slice(4))}"]`;
    list.querySelector(selector)?.focus();
  }
}

function renderNotice() {
  const noticeEl = $("characterPopoverNotice");
  if (!noticeEl) return;
  const text = controlState.notice ? noticeText(controlState.notice) : "";
  noticeEl.hidden = !text;
  noticeEl.textContent = text;
}

function renderButton() {
  const b = btn();
  if (!b) return;
  const label = b.querySelector(".composer-character-btn-label");
  const swatch = b.querySelector(".composer-character-btn-swatch");
  const icon = b.querySelector(".composer-character-btn-icon");
  const isCharacter = effectiveCharacterMode(controlState) === "character" && controlState.characterRevisionId;
  const name = isCharacter ? (controlState.characterName || t("character.unnamed")) : "";
  if (label) {
    label.textContent = name;
    label.title = name;
    label.hidden = !name;
  }
  if (swatch) {
    swatch.hidden = !isCharacter;
    swatch.textContent = isCharacter ? monogram(name) : "";
  }
  if (icon) icon.hidden = Boolean(isCharacter);
  b.classList.toggle("is-character", Boolean(isCharacter));
}

function renderPopover() {
  const p = popover();
  if (!p || p.hidden) return;
  renderNotice();
  const previewEl = $("characterImportPreview");
  const main = $("characterPopoverMain");
  if (!previewEl || !main) return;
  if (controlState.importPreview) {
    main.hidden = true;
    previewEl.hidden = false;
    renderCharacterImportPreview(previewEl, controlState.importPreview, {
      committing: controlState.importCommitting,
    });
  } else {
    previewEl.hidden = true;
    main.hidden = false;
    renderList();
  }
}

function render() {
  renderButton();
  renderPopover();
}

async function loadBinding(sessionId) {
  const seq = controlState.loadSeq;
  const api = facade();
  if (!api) {
    dispatch({ type: "availability.set", available: false });
    return;
  }
  const isCurrent = () => sessionId === controlState.sessionId && seq === controlState.loadSeq;
  try {
    const res = await api.getSessionCharacterBinding(sessionId);
    if (!isCurrent()) return;
    if (res?.ok) {
      // A successful load proves availability recovered after a kill switch.
      if (!controlState.available) dispatch({ type: "availability.set", available: true });
      dispatch({ type: "binding.loaded", sessionId, seq, binding: res.binding });
    } else {
      dispatch({ type: "binding.loadFailed", sessionId, seq, error: res?.error });
    }
  } catch {
    if (!isCurrent()) return;
    dispatch({ type: "binding.loadFailed", sessionId, seq });
  }
}

async function loadCharacters() {
  const api = facade();
  if (!api) return;
  try {
    const res = await api.listCharacters();
    if (res?.ok) dispatch({ type: "characters.loaded", characters: res.characters });
  } catch {
    /* keep the prior/empty list — fail open */
  }
}

async function selectMode(mode, character = null) {
  const sessionId = controlState.sessionId;
  const api = facade();
  if (!sessionId || !api || controlState.selecting) return;
  const expectedBindingVersion = controlState.bindingVersion;
  // Pin session + load generation: a slow set-binding resolving after a
  // session switch must not paint the old conversation's choice onto the new
  // one (the reducer re-checks both before applying any outcome).
  const seq = controlState.loadSeq;
  const isCurrent = () => sessionId === controlState.sessionId && seq === controlState.loadSeq;
  dispatch({
    type: "selection.started",
    mode,
    characterRevisionId: character?.currentRevisionId || null,
    characterName: character?.displayName || "",
  });
  try {
    const res = await api.setSessionCharacterBinding({
      sessionId,
      expectedBindingVersion,
      mode: mode === "character" ? "character" : "native",
      characterRevisionId: mode === "character" ? character?.currentRevisionId : undefined,
    });
    if (!isCurrent()) return;
    if (res?.ok) {
      dispatch({ type: "selection.settled", sessionId, seq, binding: res.binding });
      announce(mode === "character"
        ? t("character.status.selected", { name: controlState.characterName || t("character.unnamed") })
        : t("character.status.native"));
      closePopover();
    } else if (res?.error === "CHARACTER_BINDING_CONFLICT") {
      // Reconcile from the server's currentBinding; the popover stays open.
      dispatch({ type: "binding.conflict", sessionId, seq, currentBinding: res.currentBinding });
    } else {
      dispatch({ type: "selection.failed", sessionId, seq });
      void loadBinding(sessionId);
    }
  } catch {
    if (!isCurrent()) return;
    dispatch({ type: "selection.failed", sessionId, seq });
    void loadBinding(sessionId);
  }
}

async function startImportPreview() {
  const api = facade();
  if (!api || controlState.importCommitting) return;
  try {
    const res = await api.previewCharacterImport();
    if (res?.ok && res.kind === "characterCard") {
      dispatch({ type: "import.previewLoaded", preview: res });
    } else if (res?.canceled) {
      /* user dismissed the file dialog — nothing to do */
    } else {
      dispatch({ type: "import.previewFailed", error: res?.error || "CHARACTER_WORLDS_UNAVAILABLE" });
    }
  } catch {
    dispatch({ type: "import.previewFailed", error: "CHARACTER_WORLDS_UNAVAILABLE" });
  }
}

async function commitImport() {
  const preview = controlState.importPreview;
  const api = facade();
  if (!preview || !api || controlState.importCommitting) return;
  dispatch({ type: "import.commitStarted" });
  const payload = { previewToken: preview.previewToken };
  if (preview.duplicateKind === "canonical") payload.duplicateResolution = "create_copy";
  try {
    const res = await api.commitCharacterImport(payload);
    if (res?.ok) {
      const character = res.entity?.id
        ? res.entity
        : { id: `imported:${preview.previewToken.slice(0, 12)}`, displayName: preview.name, currentRevisionId: res.revision?.id };
      dispatch({ type: "import.committed", character });
      // The import always completes; the auto-select only applies when the
      // user is still in the conversation that started it.
      if (character.currentRevisionId && preview.sessionId && preview.sessionId === controlState.sessionId) {
        await selectMode("character", character);
      }
    } else {
      dispatch({ type: "import.commitFailed", error: res?.error });
    }
  } catch {
    dispatch({ type: "import.commitFailed", error: "CHARACTER_WORLDS_UNAVAILABLE" });
  }
}

/** Re-render localized chrome after a locale change. */
export function refreshCharacterControlUi() {
  render();
}

export function initCharacterSessionControl() {
  const b = btn();
  const p = popover();
  if (!b || !p) return;
  if (!facade()) {
    // Older preload without the facade: hide the control, stay native Lily.
    b.hidden = true;
    return;
  }
  b.hidden = false;

  b.addEventListener("click", (event) => {
    event.stopPropagation();
    if (p.hidden) openPopover();
    else closePopover();
  });
  $("characterPopoverClose")?.addEventListener("click", () => closePopover({ focusButton: true }));

  $("characterList")?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-character-mode], [data-character-revision-id]");
    if (!row) return;
    if (row.dataset.characterMode === "native") {
      void selectMode("native");
      return;
    }
    const character = controlState.characters
      .find((c) => c.currentRevisionId === row.dataset.characterRevisionId);
    if (character) void selectMode("character", character);
  });

  $("characterImportBtn")?.addEventListener("click", () => void startImportPreview());
  // The library manager (Phase 2B) replaces the disabled Phase 2 placeholder:
  // it opens over the whole window, so the popover closes first.
  $("characterManageBtn")?.addEventListener("click", () => {
    closePopover();
    void openCharacterLibrary();
  });
  $("characterImportPreview")?.addEventListener("click", (event) => {
    if (event.target.closest("#characterImportCommitBtn")) void commitImport();
    else if (event.target.closest("#characterImportCancelBtn")) dispatch({ type: "import.dismissed" });
  });

  // Arrow-key navigation + a hard focus trap: Tab/Shift+Tab wrap inside the
  // popover so keyboard focus can never fall behind it. A focus outside the
  // item list (indexOf -1) starts from the first/last row, not the second.
  p.addEventListener("keydown", (event) => {
    const items = focusableItems();
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[idx + 1 >= items.length ? 0 : idx + 1].focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length].focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0].focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1].focus();
    } else if (event.key === "Tab") {
      event.preventDefault();
      if (event.shiftKey) items[idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length].focus();
      else items[idx + 1 >= items.length ? 0 : idx + 1].focus();
    }
  });

  document.addEventListener("click", (event) => {
    if (p.hidden) return;
    // Use the composed path: an optimistic re-render can detach the clicked
    // row while its click is still bubbling, and contains() would then
    // wrongly report an outside click.
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(b) || path.includes(p)) return;
    closePopover();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !p.hidden) closePopover({ focusButton: true });
  });

  store.on("activeSessionId", (sid) => {
    if (sid === controlState.sessionId) return;
    if (sid) {
      dispatch({ type: "session.changed", sessionId: sid });
      void loadBinding(sid);
    } else {
      // Active session went away (deleted/none): reset the control so no
      // stale character keeps showing.
      dispatch({ type: "session.changed", sessionId: null });
    }
  });

  const initial = store.get("activeSessionId");
  if (initial) {
    dispatch({ type: "session.changed", sessionId: initial });
    void loadBinding(initial);
  }
  render();
}
