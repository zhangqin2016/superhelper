import { $, el } from "./dom.js";
import { t } from "../i18n/index.js";
import { renderAgentDetail } from "./agent-library-view.js";

const ACTION_LABEL_KEYS = {
  edit: "character.library.edit",
  history: "character.library.history",
  duplicate: "character.library.duplicate",
  export: "character.library.export",
  archive: "character.library.archive",
};

function rowActions() {
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

const AGENT_ANATOMY_PARTS = ["role", "skills", "knowledge", "mode"];

/** The "智能体 = 角色卡 + 技能 + 知识库 + 执行模式" formula, spelled out. */
function renderAgentAnatomy() {
  const card = el("div", "character-library-detail-empty character-agent-anatomy", {
    "data-agent-anatomy": "true",
  });
  card.appendChild(el("p", "character-agent-anatomy-title", { textContent: t("character.agent.anatomyTitle") }));
  const list = el("dl", "character-agent-anatomy-list");
  for (const part of AGENT_ANATOMY_PARTS) {
    const row = el("div", "character-agent-anatomy-row");
    row.appendChild(el("dt", "character-agent-anatomy-term", { textContent: t(`character.agent.anatomyTerm.${part}`) }));
    row.appendChild(el("dd", "character-agent-anatomy-meaning", { textContent: t(`character.agent.anatomy.${part}`) }));
    list.appendChild(row);
  }
  card.appendChild(list);
  card.appendChild(el("p", "character-agent-anatomy-hint", { textContent: t("character.library.selectHintAgent") }));
  return card;
}

export function renderLibraryDetail(state) {
  const detail = $("characterLibraryDetail");
  if (!detail) return;
  const item = (state.items[state.tab] || []).find((entry) => entry.id === state.selectedItemId);
  detail.dataset.libraryDetailKind = item?.kind || "empty";
  detail.dataset.libraryDetailSource = item?.source || "";
  detail.dataset.libraryDetailActive = item?.active ? "true" : "false";
  if (!item) {
    // The agents tab used to leave a bare sentence in a tall empty column.
    // Nothing is selected yet, so the panel answers the question a first-time
    // user actually has — what IS an agent — with the 4-part formula as a
    // compact definition list. Static copy only; no images, no fetches.
    if (state.tab === "agents") {
      detail.appendChild(renderAgentAnatomy());
      return;
    }
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
  if (item.kind === "agent") {
    renderAgentDetail(state, state.detail?.kind === "agent" ? state.detail : item, detail);
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
  const mutationActions = el("div", "character-library-detail-actions character-library-mutation-actions");
  if (!item.official) {
    if (state.confirm?.action === "archive" && state.confirm.entityId === item.id) {
      mutationActions.appendChild(confirmBar(t("character.library.confirmArchive", { name: item.name })));
    }
    for (const action of rowActions()) {
      mutationActions.appendChild(el("button", "character-library-action", {
        type: "button", textContent: t(ACTION_LABEL_KEYS[action]), "data-library-action": action,
      }));
    }
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
  activate.disabled = state.activation.status === "running";
  actions.appendChild(activate);
  detail.appendChild(actions);
}
