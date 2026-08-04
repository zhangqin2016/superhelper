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

const MAX_ID_CHARS = 128;
const MAX_NAME_CHARS = 256;
const MAX_SUMMARY_CHARS = 1024;
const MAX_TAGS = 32;
const MAX_TAG_CHARS = 96;
const MAX_TERMS = 24;
const MAX_TERM_CHARS = 128;
const CATEGORY_ORDER_BY_TAB = Object.freeze({
  characters: [
    "work-delivery", "research-analysis", "content-creation", "technology-creation",
    "business-operations", "technology-engineering", "data-ai", "design-engineering",
    "education-research", "healthcare", "legal-finance", "property-construction",
    "manufacturing-supply", "commerce-customer", "media-localization", "hospitality-events",
    "public-nonprofit", "agriculture-food", "freelance", "learning-growth", "life-support",
    "uncategorized",
  ],
  personas: [
    "work-identities", "creative-identities", "research-learning", "communication-profiles",
    "career-development", "life-support",
    "uncategorized",
  ],
  books: [
    "project-knowledge", "brand-language", "product-terminology", "operations-support",
    "work-operations", "writing-communication", "career-development", "life-management",
    "human-resources", "technology-engineering", "technology-security", "data-ai",
    "design-engineering", "education-training", "healthcare", "legal-compliance",
    "finance-accounting", "property-construction", "manufacturing-supply", "commerce-customer",
    "hospitality-events", "public-nonprofit-agriculture", "story-worlds", "uncategorized",
  ],
});

export const LIBRARY_GROUPS = Object.freeze({
  all: { id: "all", kind: "all" },
  official: { id: "official", kind: "source", source: "official" },
  my: { id: "my", kind: "source", source: "local" },
  recent: { id: "recent", kind: "recent" },
  archived: { id: "archived", kind: "archived" },
});

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
    source: "",
    groupId: "all",
    items: { characters: [], personas: [], books: [] },
    selectedItemId: null,
    detail: null,
    detailLoading: false,
    activation: { status: "idle", itemId: null, error: "" },
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

function boundedStrings(value, maxItems, maxChars) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => typeof entry === "string" && entry)
    .slice(0, maxItems)
    .map((entry) => entry.slice(0, maxChars));
}

function sourceOf(entry) {
  return entry?.official === true || entry?.source === "official" || entry?.officialId
    ? "official"
    : "local";
}

/** Convert a main-side summary into a bounded renderer-only card model. */
export function normalizeLibraryItem(tab, entry = {}) {
  const kind = kindForTab(tab);
  const id = text(entry?.id, MAX_ID_CHARS);
  const name = text(entry?.name || entry?.displayName, MAX_NAME_CHARS);
  const tags = boundedStrings(entry?.tags, MAX_TAGS, MAX_TAG_CHARS);
  const capabilities = boundedStrings(
    entry?.capabilities || entry?.suitableFor || entry?.capabilityTerms,
    MAX_TERMS,
    MAX_TERM_CHARS,
  );
  const workflow = boundedStrings(entry?.workflow, MAX_TERMS, MAX_TERM_CHARS);
  const categoryId = text(entry?.categoryId, 96) || "uncategorized";
  const source = sourceOf(entry);
  return {
    id,
    kind,
    name,
    tagline: text(entry?.tagline, MAX_SUMMARY_CHARS),
    summary: text(entry?.summary || entry?.description, MAX_SUMMARY_CHARS),
    categoryId,
    source,
    sourceKind: text(entry?.sourceKind, 64),
    officialId: text(entry?.officialId, MAX_ID_CHARS),
    official: source === "official",
    currentRevisionId: text(entry?.currentRevisionId || entry?.revisionId, MAX_ID_CHARS),
    tags,
    capabilities,
    workflow,
    visualKey: text(entry?.visualKey, 64),
    editorialOrder: Number.isSafeInteger(entry?.editorialOrder) ? entry.editorialOrder : Number.MAX_SAFE_INTEGER,
    recentlyUsedAt: text(entry?.recentlyUsedAt, 64),
    archived: Boolean(entry?.archived || entry?.archivedAt),
    active: Boolean(entry?.active),
    installed: Boolean(entry?.installed || entry?.installedCharacterId || entry?.currentRevisionId),
    updateAvailable: Boolean(entry?.updateAvailable),
    descriptionChars: count(entry?.descriptionChars),
    entryCount: count(entry?.entryCount),
    health: text(entry?.health, 64),
    completion: text(entry?.completion, 32),
    searchText: [name, entry?.summary, entry?.description, ...tags, ...capabilities, ...workflow]
      .filter((value) => typeof value === "string" && value)
      .join(" ")
      .slice(0, MAX_SUMMARY_CHARS * 2)
      .toLowerCase(),
  };
}

function sanitizeItems(tab, raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => normalizeLibraryItem(tab, entry)).filter((item) => item.id);
}

function isRecent(item) {
  return Boolean(item?.recentlyUsedAt && !Number.isNaN(Date.parse(item.recentlyUsedAt)));
}

function groupMatches(item, groupId) {
  if (groupId === "all") return !item.archived;
  if (groupId === "official") return item.source === "official" && !item.archived;
  if (groupId === "my") return item.source === "local" && !item.archived;
  if (groupId === "recent") return isRecent(item) && !item.archived;
  if (groupId === "archived") return item.archived;
  return item.categoryId === groupId && !item.archived;
}

/** Derive visible groups from data while keeping global groups stable. */
export function deriveLibraryGroups(tab, items) {
  const values = Array.isArray(items) ? items : [];
  const groups = [
    { ...LIBRARY_GROUPS.all, labelKey: "all" },
    { ...LIBRARY_GROUPS.official, labelKey: "official" },
  ];
  const categoryIds = [...(CATEGORY_ORDER_BY_TAB[tab] || ["uncategorized"])];
  for (const item of values) {
    if (!categoryIds.includes(item.categoryId)) categoryIds.push(item.categoryId);
  }
  categoryIds.sort((a, b) => {
    const order = CATEGORY_ORDER_BY_TAB[tab] || [];
    const indexA = order.indexOf(a);
    const indexB = order.indexOf(b);
    if (indexA >= 0 && indexB >= 0) return indexA - indexB;
    if (indexA >= 0) return -1;
    if (indexB >= 0) return 1;
    return a.localeCompare(b);
  });
  for (const categoryId of categoryIds) {
    groups.push({ id: categoryId, kind: "category", labelKey: categoryId });
  }
  groups.push(
    { ...LIBRARY_GROUPS.my, labelKey: "my" },
    { ...LIBRARY_GROUPS.recent, labelKey: "recent" },
    { ...LIBRARY_GROUPS.archived, labelKey: "archived" },
  );
  return groups.map((group) => ({
    ...group,
    count: values.filter((item) => groupMatches(item, group.id)).length,
  }));
}

/**
 * Case-insensitive substring filtering. Query matches the display name; the
 * tag filter matches any character tag (it only applies to the characters
 * tab — the controller hides it elsewhere).
 */
export function filterLibraryItems(items, { query = "", tag = "", groupId = "all", source = "" } = {}) {
  const q = String(query || "").trim().toLowerCase();
  const tagQuery = String(tag || "").trim().toLowerCase();
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (!groupMatches(item, groupId)) return false;
    if (source && item?.source !== source) return false;
    if (q && !String(item?.searchText || item?.name || "").toLowerCase().includes(q)) return false;
    if (tagQuery) {
      const tags = Array.isArray(item?.tags) ? item.tags : [];
      if (!tags.some((entry) => entry.toLowerCase().includes(tagQuery))) return false;
    }
    return true;
  });
}

/** Stable, non-mutating order for cards and test fixtures. */
export function sortLibraryItems(items, { now = Date.now() } = {}) {
  const current = Number(now) || Date.now();
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const recentA = isRecent(a) ? Math.max(0, current - Date.parse(a.recentlyUsedAt)) : Number.POSITIVE_INFINITY;
    const recentB = isRecent(b) ? Math.max(0, current - Date.parse(b.recentlyUsedAt)) : Number.POSITIVE_INFINITY;
    if (recentA !== recentB) return recentA - recentB;
    if (a.editorialOrder !== b.editorialOrder) return a.editorialOrder - b.editorialOrder;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

const FORM_VALUE_KEYS = [
  "name", "description", "personality", "scenario", "tags",
  "identity", "background", "expertise", "communicationStyle",
  "goals", "preferences", "constraints", "scanDepthMessages",
  "tokenBudget", "recursive", "worldBookEntries",
];

/** The values a freshly opened form shows (the dirty baseline). */
export function initialFormValues(mode, canonical) {
  const data = canonical && typeof canonical === "object" ? canonical : {};
  if (mode !== "edit") {
    return {
      ...Object.fromEntries(FORM_VALUE_KEYS.map((key) => [key, ""])),
      scanDepthMessages: "8",
      tokenBudget: "0",
      recursive: "true",
      worldBookEntries: "[]",
    };
  }
  const scanPolicy = data.scanPolicy && typeof data.scanPolicy === "object" ? data.scanPolicy : {};
  return {
    name: typeof data.name === "string" ? data.name : "",
    description: typeof data.description === "string" ? data.description : "",
    personality: typeof data.personality === "string" ? data.personality : "",
    scenario: typeof data.scenario === "string" ? data.scenario : "",
    tags: Array.isArray(data.tags) ? data.tags.join(", ") : "",
    identity: typeof data.identity === "string" ? data.identity : "",
    background: typeof data.background === "string" ? data.background : "",
    expertise: Array.isArray(data.expertise) ? data.expertise.join(", ") : "",
    communicationStyle: typeof data.communicationStyle === "string" ? data.communicationStyle : "",
    goals: Array.isArray(data.goals) ? data.goals.join(", ") : "",
    preferences: Array.isArray(data.preferences) ? data.preferences.join(", ") : "",
    constraints: Array.isArray(data.constraints) ? data.constraints.join(", ") : "",
    scanDepthMessages: String(Number.isFinite(scanPolicy.scanDepthMessages) ? scanPolicy.scanDepthMessages : 8),
    tokenBudget: String(Number.isFinite(scanPolicy.tokenBudget) ? scanPolicy.tokenBudget : 0),
    recursive: scanPolicy.recursive === false ? "false" : "true",
    worldBookEntries: JSON.stringify(Array.isArray(data.entries) ? data.entries : []),
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
        source: "",
        groupId: "all",
        selectedItemId: null,
        detail: null,
        detailLoading: false,
        activation: { status: "idle", itemId: null, error: "" },
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
    case "source.changed":
      return {
        ...state,
        source: action.source === "official" || action.source === "local" ? action.source : "",
        selectedItemId: null,
        detail: null,
      };
    case "group.changed":
      return {
        ...state,
        groupId: typeof action.groupId === "string" && action.groupId ? action.groupId : "all",
        selectedItemId: null,
        detail: null,
      };
    case "items.loaded": {
      if (!LIBRARY_TABS.includes(action.tab)) return state;
      return {
        ...state,
        items: { ...state.items, [action.tab]: sanitizeItems(action.tab, action.items) },
      };
    }
    case "detail.selected":
      return {
        ...state,
        selectedItemId: text(action.itemId, MAX_ID_CHARS) || null,
        detail: null,
        detailLoading: Boolean(action.itemId),
        activation: { status: "idle", itemId: text(action.itemId, MAX_ID_CHARS), error: "" },
      };
    case "detail.loaded":
      return action.itemId === state.selectedItemId
        ? { ...state, detail: action.detail || null, detailLoading: false }
        : state;
    case "detail.failed":
      return action.itemId === state.selectedItemId
        ? { ...state, detail: null, detailLoading: false, notice: { key: "action_failed", params: {} } }
        : state;
    case "detail.closed":
      return { ...state, selectedItemId: null, detail: null, detailLoading: false };
    case "activation.started":
      return {
        ...state,
        activation: { status: "running", itemId: text(action.itemId, MAX_ID_CHARS), error: "" },
      };
    case "activation.failed":
      return {
        ...state,
        activation: { status: "error", itemId: text(action.itemId, MAX_ID_CHARS), error: text(action.error, 256) },
      };
    case "activation.settled":
      return {
        ...state,
        activation: { status: "settled", itemId: text(action.itemId, MAX_ID_CHARS), error: "" },
      };
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
        selectedItemId: null,
        detail: null,
        detailLoading: false,
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
