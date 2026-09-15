/**
 * View layer for the 智能体 (agent) tab of the library dialog. Pure DOM from
 * the pure model — no IPC, no module state. Cards and the detail aside are an
 * observability surface: every capability is read-only here, and editing
 * still goes through natural language ("让 Lily 创建", memory/no-ui-natural-language.md).
 */

import { el } from "./dom.js";
import { t } from "../i18n/index.js";
import {
  AGENT_AUTONOMY_KEYS,
  AGENT_DRAFT_SOURCE_KIND,
  agentMonogram,
  agentPrimaryAction,
} from "./agent-library-model.js";

function marker(item, large = false) {
  const node = el("span", `character-library-card-marker${large ? " is-large" : ""}${item.icon ? " is-agent-icon" : ""}`, {
    textContent: item.icon || agentMonogram(item.name),
    "aria-hidden": "true",
  });
  node.dataset.agentMarker = item.icon ? "icon" : "monogram";
  return node;
}

function badge(className, text) {
  return el("span", className, { textContent: text, "aria-label": text });
}

/** Provenance/state badges shared by the card and the detail hero. */
export function renderAgentBadges(item) {
  const badges = el("span", "character-library-card-badges agent-library-badges");
  if (item.official) badges.appendChild(badge("character-library-official-badge", t("character.library.officialBadge")));
  if (item.distributed) badges.appendChild(badge("character-library-status-badge agent-badge-distributed", t("character.agent.badgeDistributed")));
  if (item.source === "local") badges.appendChild(badge("character-library-source-badge", t("character.library.sourceLocal")));
  if (item.active) badges.appendChild(badge("character-library-status-badge is-active", t("character.library.statusActive")));
  if (item.updateAvailable) badges.appendChild(badge("character-library-status-badge", t("character.library.statusUpdate")));
  if (item.sourceKind === AGENT_DRAFT_SOURCE_KIND) badges.appendChild(badge("character-library-agent-draft", t("character.agent.badgeDraft")));
  if (item.isDefault) badges.appendChild(badge("character-library-status-badge agent-badge-default", t("character.agent.badgeDefault")));
  return badges;
}

/** One grid card; the controller resolves clicks by data-entity-id. */
export function renderAgentCard(state, item) {
  const row = el("article", "character-library-row is-agent", { role: "listitem" });
  row.dataset.entityId = item.id;
  row.dataset.agentKind = "agent";
  const selected = item.id === state.selectedItemId;
  const select = el("button", "character-library-card-select", {
    type: "button",
    "data-library-select": "true",
    "aria-selected": selected ? "true" : "false",
    "aria-pressed": selected ? "true" : "false",
  });
  select.appendChild(marker(item));
  const info = el("span", "character-library-row-info");
  const name = item.name || t("character.unnamed");
  const heading = el("span", "character-library-card-heading");
  heading.appendChild(el("span", "character-library-row-name", { textContent: name, title: name }));
  info.appendChild(heading);
  const badges = renderAgentBadges(item);
  if (badges.childElementCount) info.appendChild(badges);
  if (item.description) {
    info.appendChild(el("span", "character-library-row-summary agent-library-row-description", {
      textContent: item.description, title: item.description,
    }));
  }
  if (item.tags.length) {
    const tags = el("span", "character-library-card-tags");
    for (const tag of item.tags.slice(0, 3)) tags.appendChild(el("span", "character-library-tag", { textContent: tag }));
    info.appendChild(tags);
  }
  select.appendChild(info);
  row.appendChild(select);
  return row;
}

function chipRow(labelKey, values, { emptyKey = "character.agent.inherit", dataKey } = {}) {
  const row = el("div", "agent-capability-row");
  if (dataKey) row.dataset.agentCapability = dataKey;
  row.appendChild(el("span", "agent-capability-label", { textContent: t(labelKey) }));
  const chips = el("span", "agent-capability-chips");
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!list.length) {
    chips.appendChild(el("span", "agent-capability-chip is-inherit", { textContent: t(emptyKey) }));
  } else {
    for (const value of list.slice(0, 12)) chips.appendChild(el("span", "agent-capability-chip", { textContent: value, title: value }));
  }
  row.appendChild(chips);
  return row;
}

function confirmBar(text) {
  const bar = el("div", "character-library-confirm");
  bar.appendChild(el("span", "character-library-confirm-text", { textContent: text }));
  bar.appendChild(el("button", "character-library-confirm-yes", {
    type: "button", textContent: t("character.library.confirm"), "data-library-confirm": "yes",
  }));
  bar.appendChild(el("button", "character-library-confirm-no", {
    type: "button", textContent: t("character.library.cancel"), "data-library-confirm": "no",
  }));
  return bar;
}

function primaryLabel(state, item) {
  if (state.activation.status === "running" && state.activation.itemId === item.id) return t("character.library.activating");
  switch (agentPrimaryAction(item)) {
    case "deactivate": return t("character.library.removeFromConversation");
    case "install":
    case "pending": return t("character.library.installAndUse");
    default: return t("character.library.useInConversation");
  }
}

/** The detail aside for a selected agent card (read-only capabilities). */
export function renderAgentDetail(state, item, detail) {
  const summary = item.summary;
  detail.dataset.libraryDetailKind = "agent";
  detail.dataset.libraryDetailSource = item.source;
  detail.dataset.libraryDetailActive = item.active ? "true" : "false";
  detail.appendChild(el("button", "character-library-detail-close", {
    type: "button", textContent: "×", "data-library-detail-close": "true",
    "data-i18n-aria-label": "common.close", "aria-label": t("common.close"), title: t("common.close"),
  }));
  const hero = el("div", "character-library-detail-hero");
  const header = el("div", "character-library-detail-header");
  header.appendChild(marker(item, true));
  const title = el("div", "character-library-detail-title");
  title.appendChild(el("span", "character-library-detail-name", { textContent: item.name || t("character.unnamed") }));
  header.appendChild(title);
  hero.appendChild(header);
  const status = renderAgentBadges(item);
  status.classList.add("character-library-detail-status");
  hero.appendChild(status);
  if (item.description) hero.appendChild(el("p", "character-library-detail-summary", { textContent: item.description }));
  detail.appendChild(hero);

  if (summary.starters.length) {
    const section = el("section", "character-library-detail-section", { "data-agent-section": "starters" });
    section.appendChild(el("h3", "character-library-detail-section-title", { textContent: t("character.agent.detailStarters") }));
    const list = el("ul", "character-library-detail-list");
    for (const starter of summary.starters) list.appendChild(el("li", "character-library-detail-list-item", { textContent: starter }));
    section.appendChild(list);
    detail.appendChild(section);
  }

  const capabilities = el("section", "character-library-detail-section agent-capabilities", { "data-agent-section": "capabilities" });
  capabilities.appendChild(el("h3", "character-library-detail-section-title", { textContent: t("character.agent.detailCapabilities") }));
  const grid = el("div", "agent-capability-grid");
  grid.appendChild(chipRow("character.agent.capSkills", [...new Set([...summary.skills.required, ...summary.skills.enabled])], { dataKey: "skills" }));
  grid.appendChild(chipRow("character.agent.capKnowledge", summary.knowledge.packs.map((pack) => pack.name), { dataKey: "knowledge" }));
  grid.appendChild(chipRow("character.agent.capTools", summary.tools.mcpAllow, { dataKey: "tools" }));
  grid.appendChild(chipRow("character.agent.capAutonomy", [t(AGENT_AUTONOMY_KEYS[summary.autonomy.permissionModeId] || AGENT_AUTONOMY_KEYS.inherit)], { dataKey: "autonomy" }));
  grid.appendChild(chipRow("character.agent.capModel", [summary.model.presetId || t("character.agent.modelInherit")], { dataKey: "model" }));
  if (summary.automationsCount > 0) {
    grid.appendChild(chipRow("character.agent.capAutomations", [t("character.agent.automationsCount", { count: summary.automationsCount })], { dataKey: "automations" }));
  }
  capabilities.appendChild(grid);
  detail.appendChild(capabilities);

  // Secondary (portability + lifecycle) actions for installed agents only.
  const secondary = el("div", "character-library-detail-actions character-library-mutation-actions");
  if (item.installed) {
    if (state.confirm?.kind === "agent" && state.confirm.entityId === item.id) {
      secondary.appendChild(confirmBar(state.confirm.action === "restore"
        ? t("character.agent.confirmRestore", { name: item.name })
        : t("character.library.confirmArchive", { name: item.name })));
    }
    secondary.appendChild(el("button", "character-library-action", {
      type: "button", textContent: t("character.library.export"), "data-library-action": "export",
    }));
    secondary.appendChild(el("button", "character-library-action", {
      type: "button",
      textContent: item.archived ? t("character.agent.restore") : t("character.library.archive"),
      "data-library-action": item.archived ? "restore" : "archive",
    }));
  }
  detail.appendChild(secondary);

  const primary = agentPrimaryAction(item);
  const actions = el("div", "character-library-detail-actions");
  const button = el("button", "character-library-activate", {
    type: "button",
    textContent: primaryLabel(state, item),
    [primary === "deactivate" ? "data-library-deactivate" : "data-library-activate"]: "true",
  });
  button.dataset.agentPrimary = primary;
  button.disabled = state.activation.status === "running" || item.archived;
  actions.appendChild(button);
  detail.appendChild(actions);
}
