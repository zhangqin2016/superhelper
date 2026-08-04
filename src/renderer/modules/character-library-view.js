/**
 * View layer for the character library manager (Character Worlds Phase 2B,
 * Task P2B-4). Pure DOM rendering from the pure model state — no IPC and no
 * mutable module state, so the controller (./character-library.js) stays
 * focused on facade wiring and every render is a pure function of state.
 */

import { $, el } from "./dom.js";
import { t } from "../i18n/index.js";
import { deriveLibraryGroups, filterLibraryItems, sortLibraryItems } from "./character-library-model.js";
import { renderLibraryDetail } from "./character-library-detail-view.js";

const NOTICE_KEYS = {
  load_failed: "character.library.loadFailed",
  action_failed: "character.library.actionFailed",
  name_required: "character.library.nameRequired",
  created: "character.library.created",
  saved_revision: "character.library.savedRevision",
  restored: "character.library.restored",
  duplicated: "character.library.duplicated",
  archived: "character.library.archived",
  exported: "character.library.exported",
  import_report: "character.library.importReport",
  import_failed: "character.import.failed",
  ordinary_attachment: "character.status.ordinaryAttachment",
  conflict: "character.library.conflict",
  unsaved_changes: "character.library.unsavedChanges",
  activated: "character.library.activated",
  removed: "character.library.removed",
};

export function libraryNoticeText(notice) {
  if (!notice) return "";
  const key = NOTICE_KEYS[notice.key];
  return key ? t(key, notice.params || {}) : "";
}

const ACTION_LABEL_KEYS = {
  edit: "character.library.edit",
  history: "character.library.history",
  duplicate: "character.library.duplicate",
  export: "character.library.export",
  archive: "character.library.archive",
};

const GROUP_LABEL_KEYS = {
  all: "character.library.groupAll",
  official: "character.library.groupOfficial",
  my: "character.library.groupMy",
  recent: "character.library.groupRecent",
  archived: "character.library.groupArchived",
};

const FORM_FIELDS = {
  character: ["name", "description", "personality", "scenario", "tags"],
  persona: ["name", "identity", "background", "expertise", "communicationStyle", "goals", "preferences", "constraints", "description"],
  worldBook: ["name"],
};
const FORM_FIELD_LABELS = {
  name: "character.library.fieldName",
  description: "character.library.fieldDescription",
  personality: "character.library.fieldPersonality",
  scenario: "character.library.fieldScenario",
  tags: "character.library.fieldTags",
  identity: "character.library.fieldIdentity",
  background: "character.library.fieldBackground",
  expertise: "character.library.fieldExpertise",
  communicationStyle: "character.library.fieldCommunicationStyle",
  goals: "character.library.fieldGoals",
  preferences: "character.library.fieldPreferences",
  constraints: "character.library.fieldConstraints",
};

function renderToolbar(state) {
  const tabs = $("characterLibraryTabs");
  if (tabs) {
    for (const tabBtn of tabs.querySelectorAll("[role='tab']")) {
      const selected = tabBtn.dataset.libraryTab === state.tab;
      tabBtn.setAttribute("aria-selected", selected ? "true" : "false");
      tabBtn.classList.toggle("is-active", selected);
    }
  }
  const onCharacters = state.tab === "characters";
  const tagFilter = $("characterLibraryTagFilter");
  if (tagFilter) tagFilter.hidden = !onCharacters;
  const sourceFilter = $("characterLibrarySourceFilter");
  if (sourceFilter) {
    sourceFilter.value = state.source || "";
    sourceFilter.hidden = false;
  }
  const importBtn = $("characterLibraryImportBtn");
  if (importBtn) importBtn.hidden = !onCharacters;
  const createBtn = $("characterLibraryCreateBtn");
  if (createBtn) {
    const key = "character.library.aiCreate";
    createBtn.textContent = t(key);
  }
  const hint = $("characterLibraryFacetHint");
  if (hint) {
    const key = state.tab === "personas"
      ? "character.library.facetHintPersona"
      : state.tab === "books"
        ? "character.library.facetHintWorldBook"
        : "character.library.facetHintCharacter";
    hint.textContent = t(key);
  }
}

function rowMeta(state, item) {
  if (state.tab === "personas") {
    return item.descriptionChars != null
      ? t("character.library.personaMeta", { count: item.descriptionChars })
      : "";
  }
  if (state.tab === "books") {
    return item.entryCount != null
      ? t("character.library.bookMeta", { count: item.entryCount })
      : "";
  }
  return (item.tags || []).join(" · ");
}

function rowActions(state) {
  if (state.tab === "books") return ["edit", "history", "archive"];
  if (state.tab === "personas") return ["edit", "history", "archive"];
  return ["edit", "history", "duplicate", "export", "archive"];
}

// Agent-drafted revisions (Phase 2C, Task P2C-1) carry the agent_draft source
// kind; the library badges them so the human reviewer sees the provenance
// before selecting. Detection is the shared sourceKind string — no parsing.
const AGENT_DRAFT_SOURCE_KIND = "agent_draft";

function agentDraftBadge() {
  const label = t("character.library.agentDraftBadge");
  return el("span", "character-library-agent-draft", {
    textContent: label,
    "aria-label": label,
  });
}

function confirmBar(text) {
  const bar = el("div", "character-library-confirm");
  bar.appendChild(el("span", "character-library-confirm-text", { textContent: text }));
  bar.appendChild(el("button", "character-library-confirm-yes", {
    type: "button", textContent: t("character.library.confirm"),
    "data-library-confirm": "yes",
  }));
  bar.appendChild(el("button", "character-library-confirm-no", {
    type: "button", textContent: t("character.library.cancel"),
    "data-library-confirm": "no",
  }));
  return bar;
}

function renderList(state) {
  const list = $("characterLibraryList");
  if (!list) return;
  const grid = $("characterLibraryGrid") || list;
  grid.textContent = "";
  const items = sortLibraryItems(filterLibraryItems(state.items[state.tab], {
    query: state.query,
    tag: state.tag,
    groupId: state.groupId,
    source: state.source,
  }));
  if (!items.length) {
    grid.appendChild(el("div", "character-library-empty", {
      textContent: t(state.tab === "personas"
        ? "character.library.emptyPersona"
        : state.tab === "books"
          ? "character.library.emptyWorldBook"
          : "character.library.emptyList"),
    }));
    return;
  }
  for (const item of items) {
    const row = el("article", "character-library-row", { role: "listitem" });
    row.dataset.entityId = item.id;
    const select = el("button", "character-library-card-select", {
      type: "button",
      "data-library-select": "true",
      "aria-selected": item.id === state.selectedItemId ? "true" : "false",
      "aria-pressed": item.id === state.selectedItemId ? "true" : "false",
    });
    const marker = el("span", "character-library-card-marker", {
      textContent: (item.visualKey || item.name || "L").slice(0, 1).toUpperCase(),
      "aria-hidden": "true",
    });
    const info = el("span", "character-library-row-info");
    const name = item.name || t("character.unnamed");
    const heading = el("span", "character-library-card-heading");
    heading.appendChild(el("span", "character-library-row-name", { textContent: name, title: name }));
    if (item.official) heading.appendChild(el("span", "character-library-official-badge", {
      textContent: t("character.library.officialBadge"),
    }));
    info.appendChild(heading);
    const badges = el("span", "character-library-card-badges");
    if (!item.official) badges.appendChild(el("span", "character-library-source-badge", {
      textContent: t("character.library.sourceLocal"),
    }));
    if (item.active) badges.appendChild(el("span", "character-library-status-badge is-active", {
      textContent: t("character.library.statusActive"),
    }));
    if (item.updateAvailable) badges.appendChild(el("span", "character-library-status-badge", {
      textContent: t("character.library.statusUpdate"),
    }));
    if (item.sourceKind === AGENT_DRAFT_SOURCE_KIND) badges.appendChild(agentDraftBadge());
    if (badges.childElementCount) info.appendChild(badges);
    if (item.tagline) info.appendChild(el("span", "character-library-row-tagline", {
      textContent: item.tagline,
      title: item.tagline,
    }));
    if (item.summary && item.summary !== item.tagline) info.appendChild(el("span", "character-library-row-summary", {
      textContent: item.summary,
      title: item.summary,
    }));
    if (item.tags?.length) {
      const tags = el("span", "character-library-card-tags");
      for (const tag of item.tags.slice(0, 3)) tags.appendChild(el("span", "character-library-tag", { textContent: tag }));
      info.appendChild(tags);
    }
    const meta = rowMeta(state, item);
    if (meta) info.appendChild(el("span", "character-library-row-meta", { textContent: meta, title: meta }));
    select.appendChild(marker);
    select.appendChild(info);
    row.appendChild(select);
    if (!item.official && state.confirm?.action === "archive" && state.confirm.entityId === item.id) {
      row.appendChild(confirmBar(t("character.library.confirmArchive", { name })));
    }
    // Compatibility hooks remain in the DOM for existing integrations/tests;
    // visible mutation actions are rendered in the details pane below.
    if (!item.official) {
      const compatibilityActions = el("div", "character-library-compat-actions");
      for (const action of rowActions(state)) {
        compatibilityActions.appendChild(el("button", "character-library-action", {
          type: "button",
          tabindex: "-1",
          textContent: t(ACTION_LABEL_KEYS[action]),
          "data-library-action": action,
        }));
      }
      row.appendChild(compatibilityActions);
    }
    grid.appendChild(row);
  }
}

function groupLabel(group) {
  const key = GROUP_LABEL_KEYS[group.id] || `character.library.category.${group.id}`;
  const translated = t(key);
  return translated === key ? group.id : translated;
}

function renderGroups(state) {
  const rail = $("characterLibraryGroups");
  if (!rail) return;
  rail.hidden = state.view !== "list";
  rail.textContent = "";
  for (const group of deriveLibraryGroups(state.tab, state.items[state.tab])) {
    const button = el("button", "character-library-group", {
      type: "button",
      "data-library-group": group.id,
      "aria-pressed": group.id === state.groupId ? "true" : "false",
    });
    button.classList.toggle("is-active", group.id === state.groupId);
    button.appendChild(el("span", "character-library-group-label", { textContent: groupLabel(group) }));
    button.appendChild(el("span", "character-library-group-count", { textContent: String(group.count) }));
    rail.appendChild(button);
  }
}

function formFieldValues(form) {
  // The live snapshot (synced from the DOM before any re-render) wins over
  // the stored canonical — this is what makes notice/settle/locale rebuilds
  // lossless for in-progress edits.
  if (form?.values) return form.values;
  const canonical = form?.canonical && typeof form.canonical === "object" ? form.canonical : {};
  if (!form || form.mode === "create") {
    return { name: "", description: "", personality: "", scenario: "", tags: "" };
  }
  return {
    name: typeof canonical.name === "string" ? canonical.name : "",
    description: typeof canonical.description === "string" ? canonical.description : "",
    personality: typeof canonical.personality === "string" ? canonical.personality : "",
    scenario: typeof canonical.scenario === "string" ? canonical.scenario : "",
    tags: Array.isArray(canonical.tags) ? canonical.tags.join(", ") : "",
  };
}

function parseWorldBookEntries(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function worldBookEntryDefaults(index) {
  return {
    id: `entry-${index + 1}`,
    title: "",
    enabled: true,
    content: "",
    activation: { constant: false, primaryKeys: [], secondaryKeys: [] },
    insertion: { position: "before_character" },
  };
}

const WORLD_BOOK_POSITIONS = [
  ["before_character", "character.library.worldBookPositionBeforeCharacter"],
  ["after_character", "character.library.worldBookPositionAfterCharacter"],
  ["before_examples", "character.library.worldBookPositionBeforeExamples"],
  ["after_examples", "character.library.worldBookPositionAfterExamples"],
  ["author_note_top", "character.library.worldBookPositionAuthorNoteTop"],
  ["author_note_bottom", "character.library.worldBookPositionAuthorNoteBottom"],
];

function appendWorldBookField(parent, labelKey, value, field, { multiline = false, formField = false } = {}) {
  const label = el("label", "character-library-field world-book-field");
  label.appendChild(el("span", "character-library-field-label", { textContent: t(labelKey) }));
  const input = el(multiline ? "textarea" : "input", multiline
    ? "character-library-textarea world-book-entry-content"
    : "character-library-input", {
    ...(multiline ? { rows: "5" } : { type: "text" }),
    ...(formField ? { "data-field": field } : { "data-world-entry-field": field }),
  });
  if (multiline) input.value = value || "";
  else input.value = value || "";
  label.appendChild(input);
  parent.appendChild(label);
  return input;
}

function appendWorldBookCheckbox(parent, labelKey, checked, field) {
  const label = el("label", "world-book-check");
  const input = el("input", null, { type: "checkbox", "data-world-entry-field": field });
  input.checked = Boolean(checked);
  label.appendChild(input);
  label.appendChild(el("span", null, { textContent: t(labelKey) }));
  parent.appendChild(label);
  return input;
}

function renderWorldBookForm(state, detail) {
  const form = state.form;
  const values = formFieldValues(form);
  const wrap = el("div", "character-library-form world-book-editor");
  wrap.appendChild(el("p", "world-book-editor-hint", {
    textContent: t("character.library.worldBookEditorHint"),
  }));
  appendWorldBookField(wrap, "character.library.fieldName", values.name, "name", { formField: true });

  const entries = parseWorldBookEntries(values.worldBookEntries);
  const entriesHead = el("div", "world-book-editor-section-head");
  const entriesTitle = el("div", "world-book-editor-section-title");
  entriesTitle.appendChild(el("strong", null, { textContent: t("character.library.worldBookEditorEntries") }));
  entriesTitle.appendChild(el("span", "world-book-editor-count", { textContent: String(entries.length) }));
  entriesHead.appendChild(entriesTitle);
  entriesHead.appendChild(el("button", "world-book-add-entry", {
    type: "button",
    textContent: t("character.library.worldBookEditorAddEntry"),
    "data-world-book-add": "true",
  }));
  wrap.appendChild(entriesHead);

  const list = el("div", "world-book-entry-list");
  if (!entries.length) {
    const empty = el("div", "world-book-entry-empty");
    empty.appendChild(el("strong", null, { textContent: t("character.library.worldBookEditorEmpty") }));
    empty.appendChild(el("span", null, { textContent: t("character.library.worldBookEditorEmptyHint") }));
    list.appendChild(empty);
  }
  entries.forEach((rawEntry, index) => {
    const entry = { ...worldBookEntryDefaults(index), ...rawEntry };
    entry.activation = { ...worldBookEntryDefaults(index).activation, ...(rawEntry.activation || {}) };
    entry.insertion = { ...worldBookEntryDefaults(index).insertion, ...(rawEntry.insertion || {}) };
    const card = el("article", "world-book-entry-editor");
    card.dataset.worldBookEntry = entry.id || `entry-${index + 1}`;
    const header = el("div", "world-book-entry-head");
    const heading = el("div", "world-book-entry-heading");
    heading.appendChild(el("span", "world-book-entry-index", { textContent: String(index + 1).padStart(2, "0") }));
    heading.appendChild(el("strong", null, { textContent: entry.title || t("character.library.worldBookEditorUntitled") }));
    header.appendChild(heading);
    appendWorldBookCheckbox(header, "character.library.worldBookEditorEnabled", entry.enabled !== false, "enabled");
    header.appendChild(el("button", "world-book-remove-entry", {
      type: "button",
      textContent: "×",
      title: t("character.library.worldBookEditorRemoveEntry"),
      "aria-label": t("character.library.worldBookEditorRemoveEntry"),
      "data-world-book-remove": "true",
    }));
    card.appendChild(header);

    const titleInput = appendWorldBookField(card, "character.library.worldBookEditorEntryTitle", entry.title, "title");
    titleInput.addEventListener("input", () => {
      const title = card.querySelector(".world-book-entry-heading strong");
      if (title) title.textContent = titleInput.value.trim() || t("character.library.worldBookEditorUntitled");
    });
    appendWorldBookField(card, "character.library.worldBookEditorContent", entry.content, "content", { multiline: true });
    appendWorldBookField(card, "character.library.worldBookEditorPrimaryKeys", (entry.activation.primaryKeys || []).join(", "), "primaryKeys");
    appendWorldBookField(card, "character.library.worldBookEditorSecondaryKeys", (entry.activation.secondaryKeys || []).join(", "), "secondaryKeys");

    const options = el("div", "world-book-entry-options");
    appendWorldBookCheckbox(options, "character.library.worldBookEditorConstant", entry.activation.constant === true, "constant");
    const positionLabel = el("label", "world-book-position-field");
    positionLabel.appendChild(el("span", "character-library-field-label", { textContent: t("character.library.worldBookEditorPosition") }));
    const select = el("select", "character-library-select", { "data-world-entry-field": "position" });
    for (const [value, labelKey] of WORLD_BOOK_POSITIONS) {
      const option = el("option", null, { value, textContent: t(labelKey) });
      option.selected = value === (entry.insertion.position || "before_character");
      select.appendChild(option);
    }
    positionLabel.appendChild(select);
    options.appendChild(positionLabel);
    card.appendChild(options);
    list.appendChild(card);
  });
  wrap.appendChild(list);

  const policy = el("section", "world-book-policy");
  policy.appendChild(el("div", "world-book-editor-section-title", {
    textContent: t("character.library.worldBookEditorPolicy"),
  }));
  const policyGrid = el("div", "world-book-policy-grid");
  appendWorldBookField(policyGrid, "character.library.worldBookEditorScanDepth", values.scanDepthMessages, "scanDepthMessages", { formField: true });
  appendWorldBookField(policyGrid, "character.library.worldBookEditorTokenBudget", values.tokenBudget, "tokenBudget", { formField: true });
  const recursive = el("label", "world-book-check world-book-recursive");
  const recursiveInput = el("input", null, { type: "checkbox", "data-field": "recursive" });
  recursiveInput.checked = values.recursive !== "false";
  recursive.appendChild(recursiveInput);
  recursive.appendChild(el("span", null, { textContent: t("character.library.worldBookEditorRecursive") }));
  policyGrid.appendChild(recursive);
  policy.appendChild(policyGrid);
  wrap.appendChild(policy);

  const actions = el("div", "character-library-form-actions");
  const save = el("button", "character-library-save", {
    type: "button", textContent: t("character.library.save"), "data-library-save": "true",
  });
  save.disabled = state.busy;
  actions.appendChild(save);
  actions.appendChild(el("button", "character-library-back", {
    type: "button", textContent: t("character.library.cancel"), "data-library-back": "true",
  }));
  wrap.appendChild(actions);
  detail.appendChild(wrap);
}

function renderForm(state, detail) {
  const form = state.form;
  if (form.kind === "worldBook") {
    renderWorldBookForm(state, detail);
    return;
  }
  const wrap = el("div", "character-library-form");
  if (form.mode === "create" && form.kind === "character") {
    wrap.appendChild(el("p", "character-library-form-hint", {
      textContent: t("character.library.createHint"),
    }));
  }
  if (form.mode === "edit" && Number.isInteger(form.revisionNumber)) {
    wrap.appendChild(el("div", "character-library-revision", {
      textContent: t("character.library.revisionLabel", { number: form.revisionNumber }),
      "data-library-revision": "true",
    }));
  }
  const values = formFieldValues(form);
  for (const field of FORM_FIELDS[form.kind] || ["name"]) {
    const label = el("label", "character-library-field");
    label.appendChild(el("span", "character-library-field-label", {
      textContent: t(FORM_FIELD_LABELS[field]),
    }));
    const value = values[field] || "";
    const input = field === "name" || ["tags", "expertise", "goals", "preferences", "constraints"].includes(field)
      ? el("input", "character-library-input", { type: "text", value, "data-field": field })
      : el("textarea", "character-library-textarea", { rows: "3", "data-field": field });
    if (input.tagName === "TEXTAREA") input.value = value;
    label.appendChild(input);
    wrap.appendChild(label);
  }
  const actions = el("div", "character-library-form-actions");
  const save = el("button", "character-library-save", {
    type: "button",
    textContent: t("character.library.save"),
    "data-library-save": "true",
  });
  save.disabled = state.busy;
  actions.appendChild(save);
  actions.appendChild(el("button", "character-library-back", {
    type: "button",
    textContent: t("character.library.cancel"),
    "data-library-back": "true",
  }));
  wrap.appendChild(actions);
  detail.appendChild(wrap);
}

function renderHistory(state, detail) {
  const history = state.history;
  const wrap = el("div", "character-library-history");
  const head = el("div", "character-library-history-head");
  head.appendChild(el("button", "character-library-back", {
    type: "button",
    textContent: t("character.library.back"),
    "data-library-back": "true",
  }));
  head.appendChild(el("span", "character-library-history-title", {
    textContent: t("character.library.historyFor", { name: history.name || t("character.unnamed") }),
  }));
  wrap.appendChild(head);
  const revisions = Array.isArray(history.revisions) ? history.revisions : [];
  if (!revisions.length) {
    wrap.appendChild(el("div", "character-library-empty", {
      textContent: t("character.library.historyEmpty"),
    }));
  }
  for (const revision of revisions) {
    const row = el("div", "character-library-history-row");
    row.dataset.historyRevisionId = revision.revisionId;
    row.appendChild(el("span", "character-library-history-number", {
      textContent: t("character.library.revisionLabel", { number: revision.revisionNumber }),
    }));
    const kindKey = `character.library.kind.${revision.sourceKind}`;
    const kindText = t(kindKey);
    const kindSpan = el("span", "character-library-history-kind", {
      textContent: kindText === kindKey ? String(revision.sourceKind || "") : kindText,
    });
    if (revision.sourceKind === AGENT_DRAFT_SOURCE_KIND) {
      kindSpan.classList.add("character-library-agent-draft");
      kindSpan.setAttribute("aria-label", t("character.library.agentDraftBadge"));
    }
    row.appendChild(kindSpan);
    if (revision.createdAt) {
      row.appendChild(el("span", "character-library-history-date", {
        textContent: String(revision.createdAt).slice(0, 10),
      }));
    }
    // Restore-as-new-revision is a character-channel capability in Phase 2B;
    // persona/book history stays read-only.
    if (history.kind === "character") {
      if (state.confirm?.action === "restore" && state.confirm.revisionId === revision.revisionId) {
        row.appendChild(confirmBar(
          t("character.library.confirmRestore", { number: revision.revisionNumber }),
        ));
      } else {
        row.appendChild(el("button", "character-library-action", {
          type: "button",
          textContent: t("character.library.restore"),
          "data-library-restore": "true",
        }));
      }
    }
    wrap.appendChild(row);
  }
  detail.appendChild(wrap);
}

function renderNotice(state) {
  const noticeEl = $("characterLibraryNotice");
  if (!noticeEl) return;
  const text = state.notice ? libraryNoticeText(state.notice) : "";
  noticeEl.hidden = !text;
  noticeEl.textContent = text;
}

/** Full render from state; a no-op while the dialog is closed. */
export function renderCharacterLibrary(state) {
  const modal = $("characterLibraryModal");
  if (!modal || modal.hidden) return;
  renderToolbar(state);
  renderGroups(state);
  renderNotice(state);
  const list = $("characterLibraryList");
  const detail = $("characterLibraryDetail");
  if (!list || !detail) return;
  const body = list.parentElement;
  if (body) body.dataset.libraryView = state.view;
  detail.textContent = "";
  if (state.view === "list") {
    list.hidden = false;
    detail.hidden = false;
    renderList(state);
    renderLibraryDetail(state);
  } else {
    list.hidden = true;
    detail.hidden = false;
    if (state.view === "form" && state.form) renderForm(state, detail);
    else if (state.view === "history" && state.history) renderHistory(state, detail);
  }
}
