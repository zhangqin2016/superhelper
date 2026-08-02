/**
 * Character library manager (Character Worlds Phase 2B, Task P2B-4; design
 * spec §13.2/§13.4). Replaces the disabled "manage library (Phase 2)" popover
 * item with a dialog that lists characters/personas/world books read-first
 * and drives the validated authoring bridge for mutations.
 *
 * Split: ./character-library-model.js owns the pure state,
 * ./character-library-view.js owns rendering,
 * ./character-library-actions.js owns every facade-calling operation, and
 * this module owns state, events, and focus discipline. Invariants: owner
 * scope is always derived main-side, edits create explicit new revisions
 * (never rewrites), archive/restore sit behind an inline confirm, in-progress
 * form edits are synced into state before ANY re-render (never wiped), a
 * dirty form cannot be closed silently, and failures fail open with a quiet
 * localized notice.
 */

import { $ } from "./dom.js";
import { t } from "../i18n/index.js";
import {
  initialCharacterLibraryState,
  reduceCharacterLibrary,
  kindForTab,
  initialFormValues,
  isFormDirty,
} from "./character-library-model.js";
import { renderCharacterLibrary, libraryNoticeText } from "./character-library-view.js";
import { createLibraryActions } from "./character-library-actions.js";

let libraryState = initialCharacterLibraryState();

/** Test/inspection hook: the current library state. */
export function getCharacterLibraryState() {
  return libraryState;
}

const facade = () => window.assistantClient?.characterWorlds || null;
const modal = () => $("characterLibraryModal");

const AI_AUTHORING_PROMPTS = Object.freeze({
  characters: "character.library.aiCreateCharacterPrompt",
  personas: "character.library.aiCreatePersonaPrompt",
  books: "character.library.aiCreateBookPrompt",
});

/**
 * Creation is an agent task, not a renderer-side CRUD operation. The prompt
 * stays in the current conversation so the OpenCode CLI agent can use its
 * context, skills, validation, and lily_character_draft tool.
 */
export function startAiAuthoring(kind = "characters") {
  const input = $("promptInput");
  if (!input) return false;
  const m = modal();
  if (m && !m.hidden && dirtyFormGuard()) return false;
  const starter = t(AI_AUTHORING_PROMPTS[kind] || AI_AUTHORING_PROMPTS.characters);
  const current = input.value.trim();
  input.value = current ? `${starter}\n${current}` : starter;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dataset.characterAuthoringKind = kind === "personas"
    ? "persona"
    : kind === "books" ? "worldBook" : "character";
  input.dataset.characterAuthoringStarter = starter;
  if (m && !m.hidden) {
    m.hidden = true;
    dispatch({ type: "closed" });
  }
  const popover = $("characterPopover");
  if (popover && !popover.hidden) {
    popover.hidden = true;
    $("sessionCharacterBtn")?.setAttribute("aria-expanded", "false");
  }
  input.focus();
  return true;
}

function announce(text) {
  const live = $("characterLibraryLive");
  if (live) live.textContent = text || "";
}

function dispatch(action) {
  libraryState = reduceCharacterLibrary(libraryState, action);
  renderCharacterLibrary(libraryState);
}

const FORM_VALUE_FIELDS = ["name", "description", "personality", "scenario", "tags"];

function fieldValue(name) {
  return $("characterLibraryDetail")?.querySelector(`[data-field='${name}']`)?.value ?? "";
}

function readFormValues() {
  const values = {};
  for (const field of FORM_VALUE_FIELDS) values[field] = fieldValue(field);
  return values;
}

// Snapshot the typed fields into state WITHOUT rendering (the DOM already
// shows them). Called before every dispatch that can rebuild the detail
// pane — notice, settle, busy toggle, locale refresh — so a re-render is
// always lossless for in-progress edits.
function syncFormValues() {
  if (libraryState.view !== "form" || !libraryState.form) return;
  if (!$("characterLibraryDetail")?.querySelector("[data-field='name']")) return;
  libraryState = reduceCharacterLibrary(libraryState, {
    type: "form.valuesSync",
    values: readFormValues(),
  });
}

function setNotice(notice, params) {
  syncFormValues();
  dispatch({ type: "notice.set", notice, params });
  announce(libraryNoticeText(libraryState.notice));
}

function settle(actionType, notice, params) {
  syncFormValues();
  dispatch({ type: actionType, notice, params });
  announce(libraryNoticeText(libraryState.notice));
}

const actions = createLibraryActions({
  facade,
  getState: () => libraryState,
  dispatch,
  setNotice,
  settle,
  syncFormValues,
  readFormValues,
  focusNameField: () => $("characterLibraryDetail")?.querySelector("[data-field='name']")?.focus(),
});

/** Re-render localized chrome after a locale change (lossless for edits). */
export function refreshCharacterLibraryUi() {
  syncFormValues();
  renderCharacterLibrary(libraryState);
}

// Kept for renderer regression coverage of the edit/create form mechanics.
// It is deliberately not wired to any user-facing creation button: product
// creation always starts an OpenCode CLI agent task via startAiAuthoring().
export function openCreateForTests() {
  const initialValues = initialFormValues("create", null);
  dispatch({
    type: "form.opened",
    form: {
      mode: "create",
      kind: kindForTab(libraryState.tab),
      canonical: null,
      initialValues,
      values: { ...initialValues },
    },
  });
  $("characterLibraryDetail")?.querySelector("[data-field='name']")?.focus();
}

// ---------------------------------------------------------------------------
// Open/close + focus discipline (§13.4)
// ---------------------------------------------------------------------------

export async function openCharacterLibrary(opts = {}) {
  const m = modal();
  if (!m || !facade()) return;
  dispatch({ type: "opened" });
  m.hidden = false;
  renderCharacterLibrary(libraryState);
  $("characterLibrarySearch")?.focus();
  await actions.loadCurrentTab();
  // §13.1 "edit current character" command: open the library straight into
  // the pinned character's edit form when the caller asks for it.
  if (opts.editCharacterId) {
    const item = libraryState.items.find((c) => c.id === opts.editCharacterId);
    if (item) await actions.openEdit(item);
  }
}

// The dirty-form guard, shared by every transition that would replace an
// in-progress form: close (backdrop/Escape), tab switch, and the New button.
// A dirty form stays put with an inline notice; a clean one transitions.
function dirtyFormGuard() {
  if (libraryState.view !== "form" || !libraryState.form) return false;
  syncFormValues();
  if (!isFormDirty(libraryState.form.values, libraryState.form.initialValues)) return false;
  setNotice("unsaved_changes");
  return true;
}

function closeCharacterLibrary() {
  const m = modal();
  if (!m || m.hidden) return;
  // A dirty form is never silently discarded by backdrop-click or Escape:
  // the close becomes an inline notice and the dialog stays open. The form's
  // own Cancel button remains the explicit discard path.
  if (dirtyFormGuard()) return;
  m.hidden = true;
  dispatch({ type: "closed" });
  $("sessionCharacterBtn")?.focus();
}

function focusableControls() {
  const m = modal();
  return m && !m.hidden
    ? [...m.querySelectorAll("button:not([disabled]), input, textarea")]
      .filter((node) => !node.closest("[hidden]"))
    : [];
}

// Focus follows the two-step confirm: into the confirm bar when it appears,
// back to the originating action when dismissed.
function focusListConfirm(entityId) {
  $("characterLibraryList")
    ?.querySelector(`[data-entity-id="${CSS.escape(entityId)}"] [data-library-confirm='yes']`)
    ?.focus();
}

function focusListAction(entityId, action) {
  $("characterLibraryList")
    ?.querySelector(`[data-entity-id="${CSS.escape(entityId)}"] [data-library-action='${action}']`)
    ?.focus();
}

function focusHistoryConfirm(revisionId) {
  $("characterLibraryDetail")
    ?.querySelector(`[data-history-revision-id="${CSS.escape(revisionId)}"] [data-library-confirm='yes']`)
    ?.focus();
}

function focusHistoryRestore(revisionId) {
  $("characterLibraryDetail")
    ?.querySelector(`[data-history-revision-id="${CSS.escape(revisionId)}"] [data-library-restore]`)
    ?.focus();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export function initCharacterLibrary() {
  const m = modal();
  if (!m) return;

  $("characterCreateBtn")?.addEventListener("click", () => startAiAuthoring("characters"));
  $("characterLibraryCloseBtn")?.addEventListener("click", () => closeCharacterLibrary());
  m.addEventListener("click", (event) => {
    if (event.target === m) closeCharacterLibrary();
  });

  $("characterLibraryTabs")?.addEventListener("click", (event) => {
    const tabBtn = event.target.closest("[data-library-tab]");
    if (!tabBtn) return;
    if (dirtyFormGuard()) return;
    dispatch({ type: "tab.changed", tab: tabBtn.dataset.libraryTab });
    void actions.loadCurrentTab();
  });
  $("characterLibrarySearch")?.addEventListener("input", (event) => {
    dispatch({ type: "query.changed", query: event.target.value });
  });
  $("characterLibraryTagFilter")?.addEventListener("input", (event) => {
    dispatch({ type: "tag.changed", tag: event.target.value });
  });
  $("characterLibraryCreateBtn")?.addEventListener("click", () => {
    if (dirtyFormGuard()) return;
    startAiAuthoring(libraryState.tab);
  });
  $("characterLibraryImportBtn")?.addEventListener("click", () => void actions.startImport());

  $("characterLibraryList")?.addEventListener("click", (event) => {
    const confirmBtn = event.target.closest("[data-library-confirm]");
    if (confirmBtn) {
      if (confirmBtn.dataset.libraryConfirm === "yes") {
        void actions.confirmAction();
      } else {
        const dismissed = libraryState.confirm;
        dispatch({ type: "confirm.dismissed" });
        if (dismissed?.action === "archive") focusListAction(dismissed.entityId, "archive");
      }
      return;
    }
    const actionBtn = event.target.closest("[data-library-action]");
    if (!actionBtn) return;
    const row = actionBtn.closest("[data-entity-id]");
    const item = (libraryState.items[libraryState.tab] || [])
      .find((entry) => entry.id === row?.dataset.entityId);
    if (!item) return;
    const action = actionBtn.dataset.libraryAction;
    if (action === "edit") void actions.openEdit(item);
    else if (action === "history") void actions.openHistory(item);
    else if (action === "duplicate") void actions.duplicateItem(item);
    else if (action === "export") void actions.exportItem(item);
    else if (action === "archive") {
      dispatch({
        type: "confirm.requested",
        confirm: {
          action: "archive",
          kind: kindForTab(libraryState.tab),
          entityId: item.id,
          name: item.name,
        },
      });
      focusListConfirm(item.id);
    }
  });

  // Typing syncs the form snapshot continuously, so even an unexpected
  // re-render (locale change, stray dispatch) is lossless.
  $("characterLibraryDetail")?.addEventListener("input", (event) => {
    if (event.target.closest("[data-field]")) syncFormValues();
  });

  $("characterLibraryDetail")?.addEventListener("click", (event) => {
    const confirmBtn = event.target.closest("[data-library-confirm]");
    if (confirmBtn) {
      if (confirmBtn.dataset.libraryConfirm === "yes") {
        void actions.confirmAction();
      } else {
        const dismissed = libraryState.confirm;
        dispatch({ type: "confirm.dismissed" });
        if (dismissed?.action === "restore") focusHistoryRestore(dismissed.revisionId);
      }
      return;
    }
    if (event.target.closest("[data-library-save]")) {
      void actions.saveForm();
      return;
    }
    if (event.target.closest("[data-library-back]")) {
      dispatch(libraryState.view === "history" ? { type: "history.closed" } : { type: "form.closed" });
      return;
    }
    const restoreBtn = event.target.closest("[data-library-restore]");
    if (restoreBtn) {
      const row = restoreBtn.closest("[data-history-revision-id]");
      const revision = (libraryState.history?.revisions || [])
        .find((entry) => entry.revisionId === row?.dataset.historyRevisionId);
      if (revision) {
        dispatch({
          type: "confirm.requested",
          confirm: {
            action: "restore",
            kind: "character",
            entityId: libraryState.history.entityId,
            revisionId: revision.revisionId,
            revisionNumber: revision.revisionNumber,
          },
        });
        focusHistoryConfirm(revision.revisionId);
      }
    }
  });

  // Focus trap + Escape: keyboard focus can never fall behind the dialog.
  m.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCharacterLibrary();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusableControls();
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement);
    event.preventDefault();
    if (event.shiftKey) items[idx <= 0 ? items.length - 1 : idx - 1].focus();
    else items[idx < 0 || idx + 1 >= items.length ? 0 : idx + 1].focus();
  });
}
