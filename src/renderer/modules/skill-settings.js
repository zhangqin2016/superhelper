/**
 * Skill center (settings panel) — P1 installed + P2 registry URL.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import store from "./state.js";
import { t, skillErrorMessage, tSkillCategory, getLocale, tSkillName, tSkillDesc } from "../i18n/index.js";

/** @type {{ available: object[], categories?: object[], remoteIndexes?: object[], activeCategory?: string } | null} */
let lastCatalog = null;

function isBusy() {
  return (store.get("runningSessionIds") || []).length > 0;
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

function renderInstalledRow(skill) {
  const row = document.createElement("div");
  row.className = "skills-row";
  row.dataset.skillId = skill.id;

  const main = document.createElement("div");
  main.className = "skills-row-main";

  const titleLine = document.createElement("div");
  titleLine.className = "skills-row-title";

  const name = document.createElement("span");
  name.className = "skills-row-name";
  name.textContent = tSkillName(skill);

  const badge = document.createElement("span");
  badge.className = "skills-row-badge";
  badge.textContent = sourceLabel(skill.source);

  titleLine.append(name, badge);

  const meta = document.createElement("div");
  meta.className = "skills-row-meta";
  const versionText = skill.updateAvailable
    ? `v${skill.version} → v${skill.latestVersion}`
    : `v${skill.version}`;
  meta.textContent = [versionText, permissionHint(skill)].filter(Boolean).join(" · ");

  const desc = document.createElement("p");
  desc.className = "skills-row-desc";
  desc.textContent = tSkillDesc(skill) || "";

  main.append(titleLine, meta, desc);

  const actions = document.createElement("div");
  actions.className = "skills-row-actions";

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "skills-toggle";
  toggle.checked = skill.enabled;
  toggle.setAttribute("aria-label", `${skill.enabled ? t("skills.disable") : t("skills.enable")}${tSkillName(skill)}`);

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
    showToast(nextEnabled ? t("toast.skillsEnabled", { name: tSkillName(skill) }) : t("toast.skillsDisabled", { name: tSkillName(skill) }), "success");
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

function renderAvailableRow(skill) {
  const row = document.createElement("div");
  row.className = "skills-row skills-row--available";
  row.dataset.skillId = skill.id;

  const main = document.createElement("div");
  main.className = "skills-row-main";

  const titleLine = document.createElement("div");
  titleLine.className = "skills-row-title";

  const name = document.createElement("span");
  name.className = "skills-row-name";
  name.textContent = tSkillName(skill);

  const badge = document.createElement("span");
  badge.className = "skills-row-badge";
  badge.textContent = t("skills.badge.catalog");

  if (skill.categoryLabel) {
    const cat = document.createElement("span");
    cat.className = "skills-row-category";
    cat.textContent = tSkillCategory(skill.category) || skill.categoryLabel;
    titleLine.append(name, badge, cat);
  } else {
    titleLine.append(name, badge);
  }

  const meta = document.createElement("div");
  meta.className = "skills-row-meta";
  meta.textContent = `v${skill.latestVersion}`;

  const desc = document.createElement("p");
  desc.className = "skills-row-desc";
  desc.textContent = tSkillDesc(skill) || skill.changelog || "";

  main.append(titleLine, meta, desc);

  const actions = document.createElement("div");
  actions.className = "skills-row-actions";

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

function filterAvailableByCategory(available, categoryId) {
  if (!categoryId || categoryId === "all") return available || [];
  return (available || []).filter((skill) => skill.category === categoryId);
}

function renderCategoryTabs(catalog) {
  const tabs = $("skillsCategoryTabs");
  if (!tabs) return;

  const categories = catalog?.categories || [];
  const available = catalog?.available || [];
  tabs.replaceChildren();
  tabs.hidden = available.length === 0 || categories.length === 0;
  if (tabs.hidden) return;

  const active = lastCatalog?.activeCategory || "all";

  const makeTab = (id, label) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `skills-category-tab${active === id ? " is-active" : ""}`;
    btn.textContent = label;
    btn.addEventListener("click", () => {
      if (!lastCatalog) return;
      lastCatalog.activeCategory = id;
      renderCategoryTabs(lastCatalog);
      renderAvailableList(filterAvailableByCategory(lastCatalog.available, id));
    });
    tabs.append(btn);
  };

  makeTab("all", `${t("skills.tab.all")} (${available.length})`);
  for (const cat of categories) {
    const count = available.filter((s) => s.category === cat.id).length;
    if (count === 0) continue;
    const label = tSkillCategory(cat.id) || cat.label;
    makeTab(cat.id, `${label} (${count})`);
  }
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

function renderAvailableList(available) {
  const title = $("skillsAvailableTitle");
  const list = $("skillsAvailableList");
  if (!list || !title) return;

  const items = available || [];
  title.hidden = (lastCatalog?.available || []).length === 0;
  list.replaceChildren();
  for (const skill of items) {
    list.append(renderAvailableRow(skill));
  }
}

function updateRegistryHint(catalog) {
  const hint = $("skillsRegistryHint");
  if (!hint) return;

  if (!catalog?.registryUrl && !catalog?.bundledCatalog) {
    hint.textContent = t("skills.registryHintCustom");
    return;
  }

  if (catalog?.bundledCatalog) {
    const parts = [t("skills.registryHintBundled")];
    if (catalog.publisher) parts.push(catalog.publisher);
    if (catalog.fetchedAt) {
      parts.push(t("skills.registryChecked", {
        time: new Date(catalog.fetchedAt).toLocaleString(getLocale()),
      }));
    }
    if (catalog.updatesCount > 0) parts.push(t("skills.registryUpdates", { count: catalog.updatesCount }));
    if (catalog.available?.length) parts.push(t("skills.registryAvailable", { count: catalog.available.length }));
    hint.textContent = parts.join(" · ");
    return;
  }

  const parts = [];
  if (catalog.publisher) parts.push(catalog.publisher);
  if (catalog.fetchedAt) {
    parts.push(t("skills.registryChecked", {
      time: new Date(catalog.fetchedAt).toLocaleString(getLocale()),
    }));
  }
  if (catalog.updatesCount > 0) {
    parts.push(t("skills.registryUpdates", { count: catalog.updatesCount }));
  }
  hint.textContent = parts.join(" · ") || t("skills.registryConfigured");
}

export async function refreshSkillsList() {
  const list = $("skillsList");
  if (!list) return;

  const data = await window.assistantClient.listSkills();
  if (!data?.ok) return;

  list.replaceChildren();
  for (const skill of data.skills || []) {
    list.append(renderInstalledRow(skill));
  }

  if (lastCatalog?.available) {
    renderAvailableList(lastCatalog.available);
  }
}

async function loadRegistryUrl() {
  const input = $("skillsRegistryUrl");
  if (!input) return;
  const data = await window.assistantClient.getRegistryUrl();
  if (data?.ok) {
    input.value = data.registryUrl || "";
  }
}

export async function initSkillSettings() {
  await loadRegistryUrl();

  $("skillsSaveRegistryBtn")?.addEventListener("click", async () => {
    const url = $("skillsRegistryUrl")?.value?.trim() || "";
    const result = await window.assistantClient.setRegistryUrl(url);
    if (!result.ok) {
      showToast(skillErrorMessage(result.error), "error");
      return;
    }
    showToast(url ? t("toast.skillsRegistrySaved") : t("toast.skillsRegistryCleared"), "success");
    lastCatalog = null;
    renderAvailableList([]);
    updateRegistryHint({ registryUrl: url });
  });

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

    lastCatalog = { ...result, activeCategory: lastCatalog?.activeCategory || "all" };
    updateRegistryHint(result);
    renderCategoryTabs(lastCatalog);
    renderRemoteIndexes(result.remoteIndexes || []);

    const list = $("skillsList");
    if (list) {
      list.replaceChildren();
      for (const skill of result.installed || []) {
        list.append(renderInstalledRow(skill));
      }
    }
    renderAvailableList(
      filterAvailableByCategory(result.available || [], lastCatalog.activeCategory),
    );

    if (!result.registryUrl && !result.bundledCatalog) {
      showToast(t("toast.skillsNeedRegistry"), "error");
      return;
    }
    if ((result.available || []).length === 0 && (result.updatesCount || 0) === 0) {
      showToast(t("toast.skillsUpToDate"), "success");
    } else {
      const parts = [];
      if (result.updatesCount) parts.push(t("skills.checkResultUpdates", { count: result.updatesCount }));
      if (result.available?.length) parts.push(t("skills.checkResultAvailable", { count: result.available.length }));
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

  updateRegistryHint({ registryUrl: $("skillsRegistryUrl")?.value, bundledCatalog: true });
  await refreshSkillsList();
  const bootstrap = await window.assistantClient.checkSkillUpdates();
  if (bootstrap?.ok) {
    lastCatalog = { ...bootstrap, activeCategory: "all" };
    updateRegistryHint(bootstrap);
    renderCategoryTabs(lastCatalog);
    renderRemoteIndexes(bootstrap.remoteIndexes || []);
    renderAvailableList(bootstrap.available || []);
  }
}
