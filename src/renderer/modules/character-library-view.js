/**
 * View layer for the character library manager (Character Worlds Phase 2B,
 * Task P2B-4). Pure DOM rendering from the pure model state — no IPC and no
 * mutable module state, so the controller (./character-library.js) stays
 * focused on facade wiring and every render is a pure function of state.
 */

import { $, el } from "./dom.js";
import { t } from "../i18n/index.js";
import { filterLibraryItems } from "./character-library-model.js";

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

const FORM_FIELDS = {
  character: ["name", "description", "personality", "scenario", "tags"],
  persona: ["name", "description"],
  worldBook: ["name"],
};
const FORM_FIELD_LABELS = {
  name: "character.library.fieldName",
  description: "character.library.fieldDescription",
  personality: "character.library.fieldPersonality",
  scenario: "character.library.fieldScenario",
  tags: "character.library.fieldTags",
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
  const importBtn = $("characterLibraryImportBtn");
  if (importBtn) importBtn.hidden = !onCharacters;
  const createBtn = $("characterLibraryCreateBtn");
  if (createBtn) {
    const key = state.tab === "personas"
      ? "character.library.createPersona"
      : state.tab === "books"
        ? "character.library.createBook"
        : "character.library.createCharacter";
    createBtn.textContent = t(key);
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
  if (state.tab === "books") return ["history", "archive"];
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
  list.textContent = "";
  const items = filterLibraryItems(state.items[state.tab], {
    query: state.query,
    tag: state.tag,
  });
  if (!items.length) {
    list.appendChild(el("div", "character-library-empty", {
      textContent: t("character.library.emptyList"),
    }));
    return;
  }
  for (const item of items) {
    const row = el("div", "character-library-row");
    row.dataset.entityId = item.id;
    const info = el("div", "character-library-row-info");
    const name = item.name || t("character.unnamed");
    info.appendChild(el("span", "character-library-row-name", { textContent: name, title: name }));
    if (item.sourceKind === AGENT_DRAFT_SOURCE_KIND) info.appendChild(agentDraftBadge());
    const meta = rowMeta(state, item);
    if (meta) info.appendChild(el("span", "character-library-row-meta", { textContent: meta, title: meta }));
    row.appendChild(info);
    if (state.confirm?.action === "archive" && state.confirm.entityId === item.id) {
      row.appendChild(confirmBar(t("character.library.confirmArchive", { name })));
    } else {
      const actions = el("div", "character-library-row-actions");
      for (const action of rowActions(state)) {
        actions.appendChild(el("button", "character-library-action", {
          type: "button",
          textContent: t(ACTION_LABEL_KEYS[action]),
          "data-library-action": action,
        }));
      }
      row.appendChild(actions);
    }
    list.appendChild(row);
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

function renderForm(state, detail) {
  const form = state.form;
  const wrap = el("div", "character-library-form");
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
    const input = field === "name" || field === "tags"
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
  renderNotice(state);
  const list = $("characterLibraryList");
  const detail = $("characterLibraryDetail");
  if (!list || !detail) return;
  detail.textContent = "";
  if (state.view === "list") {
    detail.hidden = true;
    list.hidden = false;
    renderList(state);
  } else {
    list.hidden = true;
    detail.hidden = false;
    if (state.view === "form" && state.form) renderForm(state, detail);
    else if (state.view === "history" && state.history) renderHistory(state, detail);
  }
}
