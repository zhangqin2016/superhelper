/**
 * Pure state model for the character library manager (Character Worlds
 * Phase 2B, Task P2B-4; design spec §13.2). No IPC, DOM, or timers — the
 * controller in ./character-library.js owns all async work and re-renders.
 *
 * The library is read-first: tabs list characters/personas/world books,
 * search + tag filtering is local, and every mutation (create/edit-as-new-
 * revision/restore/duplicate/archive) is an explicit user action confirmed
 * where destructive. Editing never rewrites a revision — a save creates
 * revision N+1 through the validated authoring bridge (§8).
 */

export const LIBRARY_TABS = ["characters", "personas", "books"];

/** Domain kind served by the authoring bridge for a library tab. */
export function kindForTab(tab) {
  return tab === "personas" ? "persona" : tab === "books" ? "worldBook" : "character";
}

export function initialCharacterLibraryState(overrides = {}) {
  return {
    open: false,
    tab: "characters",
    query: "",
    tag: "",
    items: { characters: [], personas: [], books: [] },
    view: "list", // "list" | "form" | "history"
    // form: { mode: "create"|"edit", kind, entityId, baseRevisionId,
    //         revisionNumber, canonical, initialValues, values } — values is
    //         a snapshot of the typed fields synced from the DOM BEFORE any
    //         dispatch that re-renders (notice/settle/locale), so a rebuild
    //         can never wipe in-progress edits; initialValues is the dirty
    //         baseline for the unsaved-close guard.
    form: null,
    // history: { kind, entityId, name, revisions: [] }
    history: null,
    // confirm: { action: "archive"|"restore", kind, entityId, revisionId,
    //            name, revisionNumber }
    confirm: null,
    busy: false,
    // notice: { key, params } — rendered into the single notice region and
    // mirrored to the aria-live region by the controller.
    notice: null,
    ...overrides,
  };
}

function text(value, max = 512) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sanitizeItems(tab, raw) {
  if (!Array.isArray(raw)) return [];
  const items = [];
  for (const entry of raw) {
    const id = text(entry?.id, 128);
    if (!id) continue;
    if (tab === "personas") {
      items.push({
        id,
        name: text(entry?.name, 256),
        currentRevisionId: text(entry?.currentRevisionId, 128),
        descriptionChars: count(entry?.descriptionChars),
      });
    } else if (tab === "books") {
      items.push({
        id,
        name: text(entry?.name, 256),
        currentRevisionId: text(entry?.currentRevisionId, 128),
        entryCount: count(entry?.entryCount),
      });
    } else {
      items.push({
        id,
        name: text(entry?.name, 256),
        currentRevisionId: text(entry?.currentRevisionId, 128),
        tags: Array.isArray(entry?.tags)
          ? entry.tags.filter((tag) => typeof tag === "string" && tag).slice(0, 32)
          : [],
      });
    }
  }
  return items;
}

/**
 * Case-insensitive substring filtering. Query matches the display name; the
 * tag filter matches any character tag (it only applies to the characters
 * tab — the controller hides it elsewhere).
 */
export function filterLibraryItems(items, { query = "", tag = "" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  const tagQuery = String(tag || "").trim().toLowerCase();
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (q && !String(item?.name || "").toLowerCase().includes(q)) return false;
    if (tagQuery) {
      const tags = Array.isArray(item?.tags) ? item.tags : [];
      if (!tags.some((entry) => entry.toLowerCase().includes(tagQuery))) return false;
    }
    return true;
  });
}

const FORM_VALUE_KEYS = ["name", "description", "personality", "scenario", "tags"];

/** The values a freshly opened form shows (the dirty baseline). */
export function initialFormValues(mode, canonical) {
  const data = canonical && typeof canonical === "object" ? canonical : {};
  if (mode !== "edit") {
    return { name: "", description: "", personality: "", scenario: "", tags: "" };
  }
  return {
    name: typeof data.name === "string" ? data.name : "",
    description: typeof data.description === "string" ? data.description : "",
    personality: typeof data.personality === "string" ? data.personality : "",
    scenario: typeof data.scenario === "string" ? data.scenario : "",
    tags: Array.isArray(data.tags) ? data.tags.join(", ") : "",
  };
}

function sanitizeFormValues(values) {
  const out = {};
  for (const key of FORM_VALUE_KEYS) out[key] = text(values?.[key], 1024 * 1024);
  return out;
}

/** Dirty check for the unsaved-close guard: any field off its baseline. */
export function isFormDirty(values, initialValues) {
  return FORM_VALUE_KEYS.some((key) => (
    String(values?.[key] ?? "") !== String(initialValues?.[key] ?? "")
  ));
}

export function reduceCharacterLibrary(state, action) {  switch (action?.type) {
    case "opened":
      // Fresh state on every open: lists are reloaded, no stale form or
      // confirm survives from a previous session with the dialog.
      return { ...initialCharacterLibraryState(), open: true };
    case "closed":
      return initialCharacterLibraryState();
    case "tab.changed": {
      const tab = LIBRARY_TABS.includes(action.tab) ? action.tab : state.tab;
      if (tab === state.tab && state.view === "list") return state;
      return {
        ...state,
        tab,
        query: "",
        tag: "",
        view: "list",
        form: null,
        history: null,
        confirm: null,
        notice: null,
      };
    }
    case "query.changed":
      return { ...state, query: text(action.query, 256) };
    case "tag.changed":
      return { ...state, tag: text(action.tag, 128) };
    case "items.loaded": {
      if (!LIBRARY_TABS.includes(action.tab)) return state;
      return {
        ...state,
        items: { ...state.items, [action.tab]: sanitizeItems(action.tab, action.items) },
      };
    }
    case "notice.set":
      return {
        ...state,
        notice: typeof action.notice === "string" && action.notice
          ? { key: action.notice, params: action.params || {} }
          : null,
      };
    case "notice.dismissed":
      return state.notice ? { ...state, notice: null } : state;
    case "form.opened":
      return action.form
        ? { ...state, view: "form", form: action.form, history: null, confirm: null, notice: null }
        : state;
    case "form.valuesSync":
      // Snapshot of the typed fields taken before a re-rendering dispatch;
      // never changes the view or touches any other slice.
      return state.form
        ? { ...state, form: { ...state.form, values: sanitizeFormValues(action.values) } }
        : state;
    case "form.closed":
      return state.view === "form"
        ? { ...state, view: "list", form: null, confirm: null }
        : state;
    case "history.opened":
      return action.history
        ? { ...state, view: "history", history: action.history, form: null, confirm: null, notice: null }
        : state;
    case "history.closed":
      return state.view === "history"
        ? { ...state, view: "list", history: null, confirm: null }
        : state;
    case "confirm.requested":
      return action.confirm ? { ...state, confirm: action.confirm } : state;
    case "confirm.dismissed":
      return state.confirm ? { ...state, confirm: null } : state;
    case "busy.set":
      return { ...state, busy: action.busy === true };
    case "mutation.settled":
      // A completed save/restore/duplicate/archive returns to the list; the
      // controller reloads the tab so rows reflect the domain state.
      return {
        ...state,
        view: "list",
        form: null,
        history: null,
        confirm: null,
        busy: false,
        notice: typeof action.notice === "string" && action.notice
          ? { key: action.notice, params: action.params || {} }
          : null,
      };
    case "mutation.failed":
      return {
        ...state,
        confirm: null,
        busy: false,
        notice: { key: action.notice || "action_failed", params: {} },
      };
    default:
      return state;
  }
}
