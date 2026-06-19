/**
 * Skill center (settings panel).
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t, skillErrorMessage, getLocale, tSkillName, tSkillDesc } from "../i18n/index.js";
import {
  renderSkillTree,
  syncAllSkillTreeGroupSelects,
  syncSkillTreeGroupSelect,
} from "./skills-tree-ui.js";
import { anySessionRunning } from "./session-runtime-store.js";

/** @type {{ available: object[], categories?: object[], remoteIndexes?: object[], featuredSkillIds?: string[] } | null} */
let lastCatalog = null;
/** Full installed list kept so the search filter can re-render without a refetch. */
let lastInstalledSkills = [];
/** Lowercased, trimmed search query; "" means show everything. */
let searchQuery = "";

function isBusy() {
  return anySessionRunning();
}

/** Match a skill against the current search query by name, description, id and category. */
function matchesSearch(skill) {
  if (!searchQuery) return true;
  const haystack = [
    tSkillName(skill),
    tSkillDesc(skill),
    skill?.id,
    skill?.categoryLabel,
    skill?.category,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(searchQuery);
}

/** Show a "no results" line when the active query filters a list down to nothing. */
function appendSearchEmpty(list) {
  const hint = document.createElement("p");
  hint.className = "skills-search-empty";
  hint.textContent = t("skills.searchNoResults");
  list.appendChild(hint);
}

function sourceLabel(source) {
  if (source === "bundled") return t("skills.source.bundled");
  if (source === "remote") return t("skills.source.remote");
  return t("skills.source.local");
}

function permissionHint(skill) {
  const parts = [];
  if (skill.permissions?.network) parts.push(t("skills.perm.network"));
  if (skill.permissions?.filesystem === "read") parts.push(t("skills.perm.read"));
  if (skill.permissions?.filesystem === "readwrite") parts.push(t("skills.perm.readwrite"));
  return parts.join(" · ");
}

function isNicheBlockchainSkill(skillId) {
  return /vulnerability-scanner|token-integration-analyzer/i.test(skillId);
}

function isFeaturedSkill(skillId) {
  return (lastCatalog?.featuredSkillIds || []).includes(skillId);
}

function isRecommendedSkill(skill) {
  return Boolean(skill?.featured || skill?.defaultEligible || isFeaturedSkill(skill?.id));
}

function capabilityLabel(layer) {
  const key = `skills.capability.${layer || "core"}`;
  const label = t(key);
  return label === key ? String(layer || "core") : label;
}

function riskLabel(level) {
  const key = `skills.risk.${level || "low"}`;
  const label = t(key);
  return label === key ? String(level || "low") : label;
}

function appendChip(parent, text, className = "skills-tree-row-chip") {
  const chip = document.createElement("span");
  chip.className = className;
  chip.textContent = text;
  parent.append(chip);
  return chip;
}

function renderInstalledTreeRow(skill) {
  const row = document.createElement("div");
  row.className = "skills-tree-row skills-tree-row--settings";
  row.dataset.skillId = skill.id;

  const main = document.createElement("div");
  main.className = "skills-tree-row-settings-main";

  const top = document.createElement("div");
  top.className = "skills-tree-row-settings-top";

  const name = document.createElement("span");
  name.className = "skills-tree-row-name";
  name.textContent = tSkillName(skill);
  top.append(name);
  appendChip(top, sourceLabel(skill.source));
  if (isRecommendedSkill(skill)) {
    appendChip(top, t("skills.badge.recommended"), "skills-tree-row-chip skills-tree-row-chip--accent");
  }
  if (skill.defaultEligible) {
    appendChip(top, t("skills.badge.auto"), "skills-tree-row-chip skills-tree-row-chip--accent");
  }
  if (skill.platformMandatory) {
    appendChip(top, t("skills.badge.platformMandatory"), "skills-tree-row-chip skills-tree-row-chip--muted");
  }

  if (skill.updateAvailable) {
    appendChip(top, t("skills.badge.update"), "skills-tree-row-chip skills-tree-row-chip--warn");
  }

  const meta = document.createElement("div");
  meta.className = "skills-tree-row-settings-meta";
  const versionText = skill.updateAvailable
    ? `v${skill.version} → v${skill.latestVersion}`
    : `v${skill.version}`;
  meta.textContent = [
    versionText,
    skill.capabilityLayer ? capabilityLabel(skill.capabilityLayer) : "",
    skill.riskLevel ? riskLabel(skill.riskLevel) : "",
    permissionHint(skill),
  ].filter(Boolean).join(" · ");

  const descText = tSkillDesc(skill);
  if (descText) {
    const desc = document.createElement("p");
    desc.className = "skills-tree-row-settings-desc";
    desc.textContent = descText;
    main.append(top, meta, desc);
  } else {
    main.append(top, meta);
  }

  const actions = document.createElement("div");
  actions.className = "skills-tree-row-settings-actions";

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "skills-toggle";
  toggle.checked = skill.enabled;
  toggle.disabled = !skill.canDisable || Boolean(skill.platformMandatory);
  toggle.setAttribute(
    "aria-label",
    `${skill.enabled ? t("skills.disable") : t("skills.enable")}${tSkillName(skill)}`,
  );

  toggle.addEventListener("change", async () => {
    const nextEnabled = toggle.checked;
    if (isBusy()) {
      toggle.checked = !nextEnabled;
      showToast(t("toast.sessionSkillsBusy"), "error");
      return;
    }
    const result = await window.assistantClient.setSkillEnabled(skill.id, nextEnabled);
    if (!result.ok) {
      toggle.checked = !nextEnabled;
      showToast(skillErrorMessage(result.error), "error");
      return;
    }
    showToast(
      nextEnabled
        ? t("toast.skillsEnabled", { name: tSkillName(skill) })
        : t("toast.skillsDisabled", { name: tSkillName(skill) }),
      "success",
    );
    const groupEl = row.closest(".skills-tree-group");
    if (groupEl) {
      syncSkillTreeGroupSelect(groupEl);
      const rows = groupEl.querySelectorAll(".skills-tree-row");
      let enabledCount = 0;
      rows.forEach((r) => {
        if (r.querySelector('input[type="checkbox"]')?.checked) enabledCount += 1;
      });
      const countEl = groupEl.querySelector(".skills-tree-group-count");
      if (countEl) {
        countEl.textContent = t("composer.sessionSkillsGroupCount", {
          enabled: enabledCount,
          total: rows.length,
        });
      }
    }
  });

  actions.append(toggle);

  if (skill.updateAvailable) {
    const updateBtn = document.createElement("button");
    updateBtn.type = "button";
    updateBtn.className = "skills-action-btn skills-action-btn--primary";
    updateBtn.textContent = t("skills.update");
    updateBtn.addEventListener("click", async () => {
      if (isBusy()) {
        showToast(t("toast.sessionSkillsBusy"), "error");
        return;
      }
      updateBtn.disabled = true;
      const result = await window.assistantClient.updateSkill(skill.id);
      updateBtn.disabled = false;
      if (!result.ok) {
        showToast(skillErrorMessage(result.error, result.detail), "error");
        return;
      }
      showToast(t("toast.skillsUpdated", { name: tSkillName(skill) }), "success");
      await refreshSkillsList();
    });
    actions.append(updateBtn);
  }

  if (skill.canRestore) {
    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "skills-restore-btn";
    restoreBtn.textContent = t("skills.restore");
    restoreBtn.addEventListener("click", async () => {
      if (isBusy()) {
        showToast(t("toast.sessionSkillsBusy"), "error");
        return;
      }
      const result = await window.assistantClient.restoreBundledSkill(skill.id);
      if (!result.ok) {
        showToast(skillErrorMessage(result.error), "error");
        return;
      }
      showToast(t("toast.skillsRestored", { name: tSkillName(skill) }), "success");
      await refreshSkillsList();
    });
    actions.append(restoreBtn);
  }

  if (skill.canUninstall) {
    const uninstallBtn = document.createElement("button");
    uninstallBtn.type = "button";
    uninstallBtn.className = "skills-restore-btn";
    uninstallBtn.textContent = t("skills.uninstall");
    uninstallBtn.addEventListener("click", async () => {
      if (isBusy()) {
        showToast(t("toast.sessionSkillsBusy"), "error");
        return;
      }
      const result = await window.assistantClient.uninstallSkill(skill.id);
      if (!result.ok) {
        showToast(skillErrorMessage(result.error), "error");
        return;
      }
      showToast(t("toast.skillsUninstalled", { name: tSkillName(skill) }), "success");
      await refreshSkillsList();
    });
    actions.append(uninstallBtn);
  }

  row.append(main, actions);
  return row;
}

function renderAvailableTreeRow(skill) {
  const row = document.createElement("div");
  row.className = "skills-tree-row skills-tree-row--settings skills-tree-row--available";
  row.dataset.skillId = skill.id;

  const main = document.createElement("div");
  main.className = "skills-tree-row-settings-main";

  const top = document.createElement("div");
  top.className = "skills-tree-row-settings-top";

  const name = document.createElement("span");
  name.className = "skills-tree-row-name";
  name.textContent = tSkillName(skill);
  top.append(name);
  appendChip(top, t("skills.badge.catalog"));

  if (isRecommendedSkill(skill)) {
    appendChip(top, t("skills.badge.recommended"), "skills-tree-row-chip skills-tree-row-chip--accent");
  }
  if (skill.defaultEligible) {
    appendChip(top, t("skills.badge.auto"), "skills-tree-row-chip skills-tree-row-chip--accent");
  }

  const meta = document.createElement("div");
  meta.className = "skills-tree-row-settings-meta";
  meta.textContent = [
    `v${skill.latestVersion}`,
    skill.capabilityLayer ? capabilityLabel(skill.capabilityLayer) : "",
    skill.riskLevel ? riskLabel(skill.riskLevel) : "",
  ].filter(Boolean).join(" · ");

  const descText = tSkillDesc(skill) || skill.changelog || "";
  if (descText) {
    const desc = document.createElement("p");
    desc.className = "skills-tree-row-settings-desc";
    desc.textContent = descText;
    main.append(top, meta, desc);
  } else {
    main.append(top, meta);
  }

  if (skill.category === "security" && isNicheBlockchainSkill(skill.id)) {
    const niche = document.createElement("p");
    niche.className = "skills-tree-row-settings-niche";
    niche.textContent = t("skills.nicheBlockchainHint");
    main.append(niche);
  }

  const actions = document.createElement("div");
  actions.className = "skills-tree-row-settings-actions";

  const installBtn = document.createElement("button");
  installBtn.type = "button";
  installBtn.className = "skills-action-btn skills-action-btn--primary";
  installBtn.textContent = t("skills.install");
  installBtn.addEventListener("click", async () => {
    if (isBusy()) {
      showToast(t("toast.sessionSkillsBusy"), "error");
      return;
    }
    installBtn.disabled = true;
    const result = await window.assistantClient.installSkill(skill.id);
    installBtn.disabled = false;
    if (!result.ok) {
      showToast(skillErrorMessage(result.error, result.detail), "error");
      return;
    }
    showToast(t("toast.skillsInstalled", { name: tSkillName(skill) }), "success");
    await refreshSkillsList();
    if (lastCatalog) {
      lastCatalog.available = (lastCatalog.available || []).filter((s) => s.id !== skill.id);
      renderAvailableList(lastCatalog.available);
    }
  });

  actions.append(installBtn);
  row.append(main, actions);
  return row;
}

async function toggleInstalledGroup(group, enabled) {
  if (isBusy()) {
    showToast(t("toast.sessionSkillsBusy"), "error");
    syncAllSkillTreeGroupSelects($("skillsList"));
    return;
  }
  for (const skill of group.skills) {
    if (skill.platformMandatory && !enabled) continue;
    const result = await window.assistantClient.setSkillEnabled(skill.id, enabled);
    if (!result.ok) {
      showToast(skillErrorMessage(result.error), "error");
      await refreshSkillsList();
      return;
    }
  }
  showToast(
    enabled ? t("toast.skillsGroupEnabled") : t("toast.skillsGroupDisabled"),
    "success",
  );
  await refreshSkillsList();
}

function renderInstalledList(skills) {
  const list = $("skillsList");
  if (!list) return;
  // Cache the full list only when called with fresh data; search re-renders
  // pass nothing and reuse the cache so the filter never narrows the source.
  if (skills) lastInstalledSkills = skills;
  const manageableSkills = (lastInstalledSkills || []).filter(
    (skill) => !skill.canRestore && !skill.platformMandatory,
  );
  const visible = manageableSkills.filter(matchesSearch);
  renderSkillTree(list, visible, {
    enabledKey: "enabled",
    countLabel: (group) =>
      t("composer.sessionSkillsGroupCount", {
        enabled: group.enabledCount,
        total: group.skills.length,
      }),
    renderRow: renderInstalledTreeRow,
    groupSelect: {
      disabled: isBusy(),
      onToggle: (group, groupEl, checked) => {
        void toggleInstalledGroup(group, checked);
      },
    },
  });
  if (!visible.length && searchQuery && manageableSkills.length) appendSearchEmpty(list);
  syncAllSkillTreeGroupSelects(list);
}

function renderAvailableList(available) {
  const title = $("skillsAvailableTitle");
  const list = $("skillsAvailableList");
  if (!list || !title) return;

  const items = available || [];
  title.hidden = (lastCatalog?.available || []).length === 0;

  const visible = items.filter(matchesSearch);
  renderSkillTree(list, visible, {
    countLabel: (group) =>
      t("skills.settingsGroupCount", { total: group.skills.length }),
    renderRow: renderAvailableTreeRow,
  });
  if (!visible.length && searchQuery && items.length) appendSearchEmpty(list);
}

function renderRemoteIndexes(indexes) {
  const box = $("skillsRemoteIndexes");
  if (!box) return;
  box.replaceChildren();
  if (!indexes?.length) {
    box.hidden = true;
    return;
  }

  const title = document.createElement("p");
  title.className = "skills-remote-index-title";
  title.textContent = t("skills.remoteIndexes");
  box.append(title);

  for (const item of indexes) {
    const link = document.createElement("a");
    link.className = "skills-remote-index-link";
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = item.name + (item.description ? ` — ${item.description}` : "");
    box.append(link);
  }
  box.hidden = false;
}

export function handlePresetApplyResult(result) {
  if (lastCatalog) {
    lastCatalog.presets = result.presets || lastCatalog.presets;
    if (lastCatalog.available?.length && result.installed?.length) {
      lastCatalog.available = lastCatalog.available.filter(
        (skill) => !result.installed.includes(skill.id),
      );
    }
  }
  if (lastCatalog?.available) {
    renderAvailableList(lastCatalog.available);
  }
}

function updateRegistryHint(catalog) {
  const hint = $("skillsRegistryHint");
  if (!hint) return;

  if (catalog?.bundledCatalog) {
    const parts = [t("skills.registryHintBundled")];
    if (catalog.publisher) parts.push(catalog.publisher);
    if (catalog.fetchedAt) {
      parts.push(
        t("skills.registryChecked", {
          time: new Date(catalog.fetchedAt).toLocaleString(getLocale()),
        }),
      );
    }
    if (catalog.updatesCount > 0) {
      parts.push(t("skills.registryUpdates", { count: catalog.updatesCount }));
    }
    if (catalog.available?.length) {
      parts.push(t("skills.registryAvailable", { count: catalog.available.length }));
    }
    hint.textContent = parts.join(" · ");
    return;
  }

  const parts = [];
  if (catalog.publisher) parts.push(catalog.publisher);
  if (catalog.fetchedAt) {
    parts.push(
      t("skills.registryChecked", {
        time: new Date(catalog.fetchedAt).toLocaleString(getLocale()),
      }),
    );
  }
  if (catalog.updatesCount > 0) {
    parts.push(t("skills.registryUpdates", { count: catalog.updatesCount }));
  }
  if (catalog.available?.length) {
    parts.push(t("skills.registryAvailable", { count: catalog.available.length }));
  }
  hint.textContent = parts.join(" · ") || t("skills.registryConfigured");
}

export async function refreshSkillsList() {
  const data = await window.assistantClient.listSkills();
  if (!data?.ok) return;

  renderInstalledList(data.skills || []);

  if (lastCatalog?.available) {
    renderAvailableList(lastCatalog.available);
  }
}

export async function initSkillSettings() {
  $("skillsCheckUpdatesBtn")?.addEventListener("click", async () => {
    if (isBusy()) {
      showToast(t("toast.skillsCheckBusy"), "error");
      return;
    }
    const btn = $("skillsCheckUpdatesBtn");
    if (btn) btn.disabled = true;
    const result = await window.assistantClient.checkSkillUpdates();
    if (btn) btn.disabled = false;

    if (!result.ok) {
      showToast(skillErrorMessage(result.error, result.detail), "error");
      return;
    }

    lastCatalog = { ...result };
    updateRegistryHint(result);
    renderRemoteIndexes(result.remoteIndexes || []);
    renderInstalledList(result.installed || []);
    renderAvailableList(result.available || []);

    if ((result.available || []).length === 0 && (result.updatesCount || 0) === 0) {
      showToast(t("toast.skillsUpToDate"), "success");
    } else {
      const parts = [];
      if (result.updatesCount) {
        parts.push(t("skills.checkResultUpdates", { count: result.updatesCount }));
      }
      if (result.available?.length) {
        parts.push(t("skills.checkResultAvailable", { count: result.available.length }));
      }
      showToast(parts.join("，"), "success");
    }
  });

  $("skillsRefreshBtn")?.addEventListener("click", async () => {
    if (isBusy()) {
      showToast(t("toast.skillsRefreshBusy"), "error");
      return;
    }
    const result = await window.assistantClient.refreshSkills();
    if (!result.ok) {
      showToast(skillErrorMessage(result.error), "error");
      return;
    }
    showToast(t("toast.skillsRefreshed"), "success");
    await refreshSkillsList();
  });

  $("skillsSearchInput")?.addEventListener("input", (event) => {
    searchQuery = String(event.target.value || "").trim().toLowerCase();
    renderInstalledList();
    renderAvailableList(lastCatalog?.available || []);
  });

  updateRegistryHint({ bundledCatalog: true });
  await refreshSkillsList();
  const bootstrap = await window.assistantClient.checkSkillUpdates();
  if (bootstrap?.ok) {
    lastCatalog = { ...bootstrap };
    updateRegistryHint(bootstrap);
    renderRemoteIndexes(bootstrap.remoteIndexes || []);
    renderInstalledList(bootstrap.installed || []);
    renderAvailableList(bootstrap.available || []);
  }

  const { maybeShowSkillPresetGuide } = await import("./skill-preset-guide.js");
  window.setTimeout(() => {
    maybeShowSkillPresetGuide().catch(() => {});
  }, 400);
}
