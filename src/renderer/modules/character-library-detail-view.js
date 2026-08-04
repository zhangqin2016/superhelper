import { $, el } from "./dom.js";
import { t } from "../i18n/index.js";

const ACTION_LABEL_KEYS = {
  edit: "character.library.edit",
  history: "character.library.history",
  duplicate: "character.library.duplicate",
  export: "character.library.export",
  archive: "character.library.archive",
};

function rowActions(state) {
  if (state.tab === "books") return ["edit", "history", "archive"];
  if (state.tab === "personas") return ["edit", "history", "archive"];
  return ["edit", "history", "duplicate", "export", "archive"];
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

function renderPersonaDetail(detail, data) {
  const section = el("section", "character-library-detail-section");
  section.appendChild(el("h3", "character-library-detail-section-title", {
    textContent: t("character.library.detailPersona"),
  }));
  const completion = data.completion === "ready"
    ? t("character.library.statusReady")
    : t("character.library.statusIncomplete");
  section.appendChild(el("p", "character-library-detail-copy", {
    textContent: `${t("character.library.detailCompletion")}: ${completion}`,
  }));
  if (Number.isSafeInteger(data.descriptionChars)) {
    section.appendChild(el("p", "character-library-detail-copy", {
      textContent: t("character.library.personaMeta", { count: data.descriptionChars }),
    }));
  }
  section.appendChild(el("p", "character-library-detail-copy", {
    textContent: t("character.library.detailPersonaSafe"),
  }));
  const fields = [
    ["character.library.fieldIdentity", data.identity],
    ["character.library.fieldBackground", data.background],
    ["character.library.fieldExpertise", Array.isArray(data.expertise) ? data.expertise.join("、") : ""],
    ["character.library.fieldCommunicationStyle", data.communicationStyle],
    ["character.library.fieldGoals", Array.isArray(data.goals) ? data.goals.join("、") : ""],
    ["character.library.fieldPreferences", Array.isArray(data.preferences) ? data.preferences.join("、") : ""],
    ["character.library.fieldConstraints", Array.isArray(data.constraints) ? data.constraints.join("、") : ""],
  ];
  for (const [labelKey, value] of fields) {
    if (!value) continue;
    section.appendChild(el("p", "character-library-detail-copy", {
      textContent: `${t(labelKey)}: ${value}`,
    }));
  }
  detail.appendChild(section);
}

function renderWorldBookDetail(detail, data) {
  const section = el("section", "character-library-detail-section");
  section.appendChild(el("h3", "character-library-detail-section-title", {
    textContent: t("character.library.detailWorldBook"),
  }));
  const report = data.report || {};
  const healthKey = `character.library.health.${data.health}`;
  const health = t(healthKey) === healthKey
    ? (data.health || t("character.library.unavailable"))
    : t(healthKey);
  const conflictKey = `character.library.conflictStatus.${data.conflictStatus}`;
  const conflicts = t(conflictKey) === conflictKey
    ? (data.conflictStatus || t("character.library.unavailable"))
    : t(conflictKey);
  const rows = [
    [t("character.library.detailEntries"), data.entryCount ?? report.entryCount],
    [t("character.library.detailEnabledEntries"), report.enabledCount],
    [t("character.library.detailConstantEntries"), report.constantCount],
    [t("character.library.detailScope"), data.scope ?? t("character.library.unavailable")],
    [t("character.library.detailHealth"), health],
    [t("character.library.detailConflicts"), conflicts],
    [t("character.library.detailBudget"), Number.isSafeInteger(data.estimatedContextTokens)
      ? `${data.estimatedContextTokens} tokens`
      : t("character.library.unavailable")],
    [t("character.library.detailMergeStrategy"), data.mergeStrategy ?? t("character.library.unavailable")],
  ];
  for (const [label, value] of rows) {
    section.appendChild(el("p", "character-library-detail-copy", {
      textContent: `${label}: ${value ?? t("character.library.unavailable")}`,
    }));
  }
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (entries.length) {
    const entrySection = el("section", "character-library-detail-section");
    entrySection.appendChild(el("h3", "character-library-detail-section-title", {
      textContent: t("character.library.detailEntryList"),
    }));
    const list = el("ul", "character-library-detail-list");
    for (const entry of entries.slice(0, 40)) {
      const title = entry.title || entry.id || t("character.library.untitledEntry");
      const flags = [
        entry.constant ? t("character.library.entryConstant") : t("character.library.entryTriggered"),
        entry.enabled === false ? t("character.library.entryDisabled") : t("character.library.entryEnabled"),
      ];
      list.appendChild(el("li", "character-library-detail-list-item", {
        textContent: `${title} · ${flags.join(" · ")}`,
      }));
    }
    if (data.entriesTruncated) {
      entrySection.appendChild(el("p", "character-library-detail-copy", {
        textContent: t("character.library.entryListTruncated"),
      }));
    }
    entrySection.appendChild(list);
    detail.appendChild(entrySection);
  }
  detail.appendChild(section);
}

export function renderLibraryDetail(state) {
  const detail = $("characterLibraryDetail");
  if (!detail) return;
  const item = (state.items[state.tab] || []).find((entry) => entry.id === state.selectedItemId);
  detail.dataset.libraryDetailKind = item?.kind || "empty";
  detail.dataset.libraryDetailSource = item?.source || "";
  detail.dataset.libraryDetailActive = item?.active ? "true" : "false";
  if (!item) {
    detail.appendChild(el("div", "character-library-detail-empty", {
      textContent: t("character.library.selectHint"),
    }));
    return;
  }
  if (state.detailLoading) {
    detail.appendChild(el("div", "character-library-detail-empty", {
      textContent: t("character.library.loadingDetail"),
    }));
    return;
  }
  const data = state.detail || item;
  const close = el("button", "character-library-detail-close", {
    type: "button", textContent: "×", "data-library-detail-close": "true",
    "data-i18n-aria-label": "common.close", "aria-label": t("common.close"),
    title: t("common.close"),
  });
  detail.appendChild(close);
  const hero = el("div", "character-library-detail-hero");
  const header = el("div", "character-library-detail-header");
  const marker = el("span", "character-library-card-marker is-large", {
    textContent: (item.visualKey || item.name || "L").slice(0, 1).toUpperCase(),
    "aria-hidden": "true",
  });
  marker.dataset.visualKey = item.visualKey || item.name || "L";
  header.appendChild(marker);
  const title = el("div", "character-library-detail-title");
  title.appendChild(el("span", "character-library-detail-name", {
    textContent: data.displayName || data.name || t("character.unnamed"),
  }));
  if (data.tagline) title.appendChild(el("span", "character-library-detail-tagline", { textContent: data.tagline }));
  header.appendChild(title);
  if (data.official || item.official) header.appendChild(el("span", "character-library-official-badge", {
    textContent: t("character.library.officialBadge"),
  }));
  hero.appendChild(header);
  const status = el("div", "character-library-detail-status");
  status.appendChild(el("span", "character-library-source-badge", {
    textContent: item.official ? t("character.library.sourceOfficial") : t("character.library.sourceLocal"),
  }));
  if (item.active) status.appendChild(el("span", "character-library-status-badge is-active", {
    textContent: t("character.library.statusActive"),
  }));
  if (item.updateAvailable) status.appendChild(el("span", "character-library-status-badge", {
    textContent: t("character.library.statusUpdate"),
  }));
  hero.appendChild(status);
  if (data.category) hero.appendChild(el("div", "character-library-detail-category", { textContent: data.category }));
  const summary = data.summary || data.description;
  if (summary) hero.appendChild(el("p", "character-library-detail-summary", { textContent: summary }));
  detail.appendChild(hero);

  const sections = item.kind === "character" && item.official
    ? [
      ["suitableFor", "character.library.detailSuitableFor"],
      ["requiredInputs", "character.library.detailInputs"],
      ["workflow", "character.library.detailWorkflow"],
      ["deliverables", "character.library.detailDeliverables"],
      ["qualityChecks", "character.library.detailChecks"],
      ["boundaries", "character.library.detailBoundaries"],
    ]
    : [];
  for (const [field, labelKey] of sections) {
    const values = Array.isArray(data[field]) ? data[field].filter(Boolean) : [];
    if (!values.length) continue;
    const section = el("section", "character-library-detail-section");
    section.appendChild(el("h3", "character-library-detail-section-title", { textContent: t(labelKey) }));
    const list = el("ul", "character-library-detail-list");
    for (const value of values.slice(0, 8)) {
      list.appendChild(el("li", "character-library-detail-list-item", { textContent: value }));
    }
    section.appendChild(list);
    detail.appendChild(section);
  }
  if (item.kind === "character") {
    const setup = [[t("character.library.fieldPersonality"), data.personality], [t("character.library.fieldScenario"), data.scenario]];
    if (setup.some(([, value]) => value)) {
      const section = el("section", "character-library-detail-section");
      section.appendChild(el("h3", "character-library-detail-section-title", { textContent: t("character.library.detailSetup") }));
      for (const [label, value] of setup) {
        if (value) section.appendChild(el("p", "character-library-detail-copy", {
          textContent: item.official ? value : `${label}: ${value}`,
        }));
      }
      detail.appendChild(section);
    }
  }
  if (item.kind === "persona") renderPersonaDetail(detail, data);
  if (item.kind === "worldBook") renderWorldBookDetail(detail, data);

  const mutationActions = el("div", "character-library-detail-actions character-library-mutation-actions");
  const canMutateWorldBook = item.kind === "worldBook" && Boolean(item.currentRevisionId);
  if (!item.official || canMutateWorldBook) {
    if (state.confirm?.action === "archive" && state.confirm.entityId === item.id) {
      mutationActions.appendChild(confirmBar(t("character.library.confirmArchive", { name: item.name })));
    }
    for (const action of rowActions(state)) {
      mutationActions.appendChild(el("button", "character-library-action", {
        type: "button", textContent: t(ACTION_LABEL_KEYS[action]), "data-library-action": action,
      }));
    }
  }
  if (item.kind === "worldBook" && data.active) {
    mutationActions.appendChild(el("button", "character-library-action", {
      type: "button",
      textContent: t("character.library.removeFromConversation"),
      "data-library-remove-book": "true",
    }));
  }
  detail.appendChild(mutationActions);
  const actions = el("div", "character-library-detail-actions");
  const activate = el("button", "character-library-activate", {
    type: "button",
    textContent: state.activation.status === "running"
      ? t("character.library.activating")
      : item.official && !item.currentRevisionId
        ? t("character.library.installAndUse")
        : t("character.library.useInConversation"),
    "data-library-activate": "true",
  });
  activate.disabled = state.activation.status === "running"
    || (item.kind === "persona" && data.completion === "incomplete");
  actions.appendChild(activate);
  detail.appendChild(actions);
}
