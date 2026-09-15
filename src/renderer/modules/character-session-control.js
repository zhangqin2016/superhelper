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
  effectiveBindingUpdates,
} from "./character-control-model.js";
import { createBindingUpdateApplier, createRoleBannerRenderer, createSwitchNoticeLoader, renderBindingUpdateRow } from "./character-binding-updates.js";
import { monogram, renderCharacterImportPreview } from "./character-import-preview.js";
import { createCharacterImportOpener } from "./character-import-opener.js";
import { createSceneSectionController } from "./character-scene-section.js";
import { openCharacterLibrary } from "./character-library.js";
import { createOfficialCharacterLoader, installOfficialCharacter } from "./official-character-picker.js";
import { createRoleListRenderer } from "./character-role-list-view.js";
import { createCharacterPreviewController } from "./character-preview-controller.js";
import { bindCharacterPopoverPosition, positionCharacterPopover } from "./character-popover-position.js";
import { getRuntimeSession, subscribeRuntime } from "./session-runtime-store.js";
import { wireAgentSessionSection } from "./character-session-agent-wiring.js";
export {
  initialCharacterControlState,
  reduceCharacterControl,
  effectiveCharacterMode,
  effectiveBindingUpdates,
};
// -------------------------------------------------------------
let controlState = initialCharacterControlState();
/** Test/inspection hook: the current session-scoped control state. */
export function getCharacterControlState() {
  return controlState;
}
/** Test hook: drive the controller's reducer directly (node tests). */
export const dispatchCharacterControl = (action) => dispatch(action);

const facade = () => window.assistantClient?.characterWorlds || null;
const btn = () => $("sessionRoleBanner");
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
  positionCharacterPopover({ panel: p, trigger: b });
  void loadCharacters();
  // Refresh binding + update hint on open (library edits show up).
  if (controlState.sessionId) { void loadBinding(controlState.sessionId); void agentSection.load(controlState.sessionId); }
  renderPopover();
  focusableItems()[0]?.focus();
}

function renderNotice() {
  const noticeEl = $("characterPopoverNotice");
  if (!noticeEl) return;
  const text = controlState.notice ? noticeText(controlState.notice) : "";
  noticeEl.hidden = !text;
  noticeEl.textContent = text;
}

function renderUpdateRow() {
  renderBindingUpdateRow($("characterUpdateRow"), controlState);
}

function renderPopover() {
  const p = popover();
  const b = btn();
  if (!p || p.hidden) return;
  renderNotice();
  renderUpdateRow();
  const editBtn = $("characterEditCurrentBtn");
  if (editBtn) editBtn.hidden = !(effectiveCharacterMode(controlState) === "character" && controlState.characterRevisionId);
  const previewEl = $("characterImportPreview");
  const main = $("characterPopoverMain");
  if (!previewEl || !main) return;
  if (controlState.importPreview) {
    main.hidden = true;
    previewEl.hidden = false;
    renderCharacterImportPreview(previewEl, controlState.importPreview, { committing: controlState.importCommitting }); } else {
    previewEl.hidden = true;
    main.hidden = false;
    renderList();
    sceneSection.load();
  }
  requestAnimationFrame(() => positionCharacterPopover({ panel: p, trigger: b }));
}

function render() {
  renderPopover();
  renderRoleBanner(); agentWiring.decorateBanner(); // agent label wins over the role name when bound
  previewController.render();
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
            if (!controlState.available) dispatch({ type: "availability.set", available: true });
      dispatch({
        type: "binding.loaded",
        sessionId,
        seq,
        binding: res.binding,
        characterName: res.characterName,
        updates: res.updates,
      });
      void loadSwitchNotices(sessionId);
    } else {
      dispatch({ type: "binding.loadFailed", sessionId, seq, error: res?.error });
    }
  } catch {
    if (!isCurrent()) return;
    dispatch({ type: "binding.loadFailed", sessionId, seq });
  }
}

function handleCharacterLibraryActivation(event) {
  const sessionId = event?.detail?.sessionId;
  if (!sessionId || sessionId !== controlState.sessionId) return;
  // Library activation commits through the same main-side binding CAS as the
  // quick selector. Refresh the session projection immediately so the
  // composer banner and its application badges cannot show the old role.
  void loadBinding(sessionId);
}

const loadCharacters = createOfficialCharacterLoader({ getFacade: facade, dispatch });

const loadSwitchNotices = createSwitchNoticeLoader({ getState: () => controlState, getFacade: facade });

async function selectMode(mode, character = null) {
  const sessionId = controlState.sessionId;
  const api = facade();
  if (!sessionId || !api || controlState.selecting) return;
  const expectedBindingVersion = controlState.bindingVersion;
  // Pin session + load generation: stale set-binding must not paint another
  // conversation's choice (the reducer re-checks both).
  const seq = controlState.loadSeq;
  const isCurrent = () => sessionId === controlState.sessionId && seq === controlState.loadSeq;
  dispatch({
    type: "selection.started",
    mode,
    characterRevisionId: character?.currentRevisionId || null,
    characterName: character?.displayName || "",
  });
  try {
    const resolvedCharacter = mode === "character"
      ? await installOfficialCharacter(api, character)
      : character;
    if (mode === "character" && !resolvedCharacter) {
      dispatch({ type: "selection.failed", sessionId, seq });
      return;
    }
    const res = await api.setSessionCharacterBinding({
      sessionId,
      expectedBindingVersion,
      mode: mode === "character" ? "character" : "native",
      characterRevisionId: mode === "character" ? resolvedCharacter?.currentRevisionId : undefined,
    });
    if (!isCurrent()) return;
    if (res?.ok) {
      dispatch({ type: "selection.settled", sessionId, seq, binding: res.binding,
        characterName: mode === "character" ? resolvedCharacter?.displayName || "" : "" });
      const roleName = mode === "character" ? controlState.characterName || t("character.unnamed") : t("character.nativeOption");
      // A role change can release the bound agent (main reports it): say so,
      // re-read the agent section and let the banner drop the agent chip.
      announce(res.agentDeactivated
        ? t("character.agent.replacedByRole", { role: roleName, agent: res.agentDeactivated.name || "" })
        : mode === "character" ? t("character.status.selected", { name: roleName }) : t("character.status.native"));
      closePopover();
      // Refresh the update hint + switch notices from the committed state.
      void loadBinding(sessionId);
      if (res.agentDeactivated) void agentSection.load(sessionId);
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

const sceneSection = createSceneSectionController({ getState: () => controlState, getFacade: facade, getElement: $, t });
const renderRoleBanner = createRoleBannerRenderer({ getState: () => controlState, getElement: $, monogram, el, t });
const previewController = createCharacterPreviewController({ getState: () => controlState, dispatch, getFacade: facade, getElement: $, refreshBinding: loadBinding });

const agentWiring = wireAgentSessionSection({
  getState: () => controlState, getElement: $, el, t, announce, loadBinding, closePopover, renderRoleBanner, btn, popover, openLibrary: openCharacterLibrary,
  renderRoleList: () => { if (popover() && !popover().hidden && !controlState.importPreview) renderList(); },
}), agentSection = agentWiring.section;
export const getAgentSessionSectionState = () => agentSection.getState(); // test/inspection hook
const renderList = createRoleListRenderer({ getState: () => controlState, getElement: $, el, t, monogram, getActiveAgent: () => agentSection.activeAgent() });

export const applyBindingUpdates = createBindingUpdateApplier({
  getState: () => controlState,
  dispatch,
  getFacade: facade,
  announce,
  refresh: loadBinding,
});

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

export const openCharacterImportPreview = createCharacterImportOpener({ getFacade: facade, dispatch, openPopover });

export function initCharacterSessionControl() {
  const b = btn();
  const p = popover();
  if (!b || !p) return;
  if (!facade()) {
    // Older preload without the facade: hide the control, stay native Lily.
    b.hidden = true;
    return;
  }
  bindCharacterPopoverPosition({ panel: p, trigger: b }); agentSection.bind();
  subscribeRuntime(() => {
    if (!controlState.sessionId) return;
    const runtime = getRuntimeSession(controlState.sessionId);
    dispatch({ type: "application.updated", sessionId: controlState.sessionId, application: runtime.characterApplication });
    agentWiring.observeRuntime(runtime);
  });
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    if (p.hidden) openPopover();
    else closePopover();
  });
  $("characterPopoverClose")?.addEventListener("click", () => closePopover({ focusButton: true }));

  $("characterList")?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-character-mode], [data-character-revision-id], [data-character-official-id]");
    if (!row) return;
    if (row.dataset.characterMode === "native") {
      void selectMode("native");
      return;
    }
    const character = controlState.characters
      .find((c) => c.currentRevisionId === row.dataset.characterRevisionId
        || c.officialId === row.dataset.characterOfficialId);
    if (character) void selectMode("character", character);
  });

  $("characterImportBtn")?.addEventListener("click", () => void startImportPreview());
  $("characterEditCurrentBtn")?.addEventListener("click", () => {
    const pinned = controlState.characters.find((c) => c.currentRevisionId === controlState.characterRevisionId);
    closePopover({ focusButton: true });
    void openCharacterLibrary({ editCharacterId: pinned?.id || controlState.characterRevisionId });
  });
  $("characterUpdateRow")?.addEventListener("click", (event) => {
    if (event.target.closest('[data-action="apply-update"]')) void applyBindingUpdates();
  });
  // The library manager (Phase 2B) replaces the disabled Phase 2 placeholder:
  // it opens over the whole window, so the popover closes first.
  sceneSection.bind();
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
  previewController.bind();
  window.addEventListener("lily:character-library-activated", handleCharacterLibraryActivation);

  store.on("activeSessionId", (sid) => {
    if (sid === controlState.sessionId) return;
    if (sid) {
      dispatch({ type: "session.changed", sessionId: sid });
      void loadBinding(sid);
      void previewController.load(sid); void agentSection.load(sid);
    } else {
      // Active session went away (deleted/none): reset the control so no
      // stale character keeps showing.
      dispatch({ type: "session.changed", sessionId: null }); void agentSection.load(null);
    }
  });

  const initial = store.get("activeSessionId");
  if (initial) {
    dispatch({ type: "session.changed", sessionId: initial });
    void loadBinding(initial);
    void previewController.load(initial); void agentSection.load(initial);
  }
  render();
}
