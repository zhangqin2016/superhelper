/**
 * Workspace app catalog (settings panel).
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t, getLocale } from "../i18n/index.js";
import { refreshState, applySessionSwitch, updateTopbarTitles } from "./session-chrome.js";
import { expandProjectGroup, renderProjectTree } from "./project-tree.js";
import { revealLocalFileInFolder } from "./file-reveal.js";

let lastCatalog = null;

function formatSize(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function appTypeLabel(value) {
  const key = `apps.type.${value || "workspace"}`;
  const label = t(key);
  return label === key ? String(value || "workspace") : label;
}

function riskLabel(value) {
  const key = `skills.risk.${value || "low"}`;
  const label = t(key);
  return label === key ? String(value || "low") : label;
}

function appendChip(parent, text, className = "workspace-app-chip") {
  if (!text) return null;
  const chip = document.createElement("span");
  chip.className = className;
  chip.textContent = text;
  parent.append(chip);
  return chip;
}

function renderEmpty(message) {
  const list = $("workspaceAppsList");
  if (!list) return;
  list.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "workspace-app-empty";
  empty.textContent = message;
  list.append(empty);
}

function renderAppCard(app) {
  const card = document.createElement("article");
  card.className = "workspace-app-card";
  card.dataset.appId = app.id;

  const header = document.createElement("div");
  header.className = "workspace-app-card-header";

  const titleBox = document.createElement("div");
  titleBox.className = "workspace-app-card-titlebox";

  const title = document.createElement("h4");
  title.className = "workspace-app-card-title";
  title.textContent = app.name || app.id;

  const meta = document.createElement("p");
  meta.className = "workspace-app-card-meta";
  meta.textContent = [
    `v${app.latestVersion || "-"}`,
    app.category || "",
    appTypeLabel(app.appType),
    riskLabel(app.riskLevel),
    formatSize(app.sizeBytes),
  ].filter(Boolean).join(" · ");

  titleBox.append(title, meta);

  const chips = document.createElement("div");
  chips.className = "workspace-app-chips";
  if (app.featured) appendChip(chips, t("apps.featured"), "workspace-app-chip workspace-app-chip--accent");
  if (app.installed) appendChip(chips, app.updateAvailable ? t("apps.updateAvailable") : t("apps.installed"), "workspace-app-chip workspace-app-chip--accent");
  for (const tag of app.tags || []) appendChip(chips, tag);

  header.append(titleBox, chips);

  const summary = document.createElement("p");
  summary.className = "workspace-app-card-summary";
  summary.textContent = app.summary || app.description || "";

  const deps = document.createElement("p");
  deps.className = "workspace-app-card-deps";
  const depParts = [];
  if (app.installedPath) {
    depParts.push(t("apps.installedPath", { path: app.installedPath }));
  }
  if (Number(app.installedCount || 0) > 1) {
    depParts.push(t("apps.installedCount", { count: app.installedCount }));
  }
  if (app.requiredRuntimePacks?.length) {
    depParts.push(t("apps.runtimeDeps", { items: app.requiredRuntimePacks.join(", ") }));
  }
  if (app.requiredSkillPackages?.length) {
    depParts.push(t("apps.skillDeps", { items: app.requiredSkillPackages.join(", ") }));
  }
  deps.textContent = depParts.join(" · ");
  deps.hidden = depParts.length === 0;

  const actions = document.createElement("div");
  actions.className = "workspace-app-card-actions";

  if (app.installed && !app.updateAvailable) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "settings-action-btn settings-action-btn--primary";
    open.textContent = t("apps.openInstalled");
    open.disabled = !app.installedAvailable;
    open.addEventListener("click", () => void openInstalledWorkspaceApp(app, open));
    actions.append(open);

    const createAnother = document.createElement("button");
    createAnother.type = "button";
    createAnother.className = "settings-action-btn settings-action-btn--primary";
    createAnother.textContent = t("apps.createAnother");
    createAnother.addEventListener("click", () => {
      void installWorkspaceApp({ ...app, forceNewInstance: true }, createAnother);
    });
    actions.append(createAnother);

    if (app.installedPath) {
      const reveal = document.createElement("button");
      reveal.type = "button";
      reveal.className = "settings-action-btn";
      reveal.textContent = t("apps.showInFolder");
      reveal.disabled = !app.installedAvailable;
      reveal.addEventListener("click", () => void revealLocalFileInFolder(app.installedPath));
      actions.append(reveal);
    }

    const uninstall = document.createElement("button");
    uninstall.type = "button";
    uninstall.className = "settings-action-btn";
    uninstall.textContent = t("apps.uninstall");
    uninstall.addEventListener("click", () => void uninstallWorkspaceApp(app, uninstall));
    actions.append(uninstall);
  } else {
    if (app.installed && app.updateAvailable) {
      const createAnother = document.createElement("button");
      createAnother.type = "button";
      createAnother.className = "settings-action-btn";
      createAnother.textContent = t("apps.createAnother");
      createAnother.addEventListener("click", () => {
        void installWorkspaceApp({ ...app, forceNewInstance: true }, createAnother);
      });
      actions.append(createAnother);
    }

    const download = document.createElement("button");
    download.type = "button";
    download.className = "settings-action-btn settings-action-btn--primary workspace-app-download";
    download.textContent = app.installed && app.updateAvailable ? t("apps.upgrade") : t("apps.install");
    download.disabled = !app.downloadUrl;
    download.addEventListener("click", () => {
      void installWorkspaceApp(app, download);
    });
    actions.append(download);
  }
  card.append(header, summary, deps, actions);
  return card;
}

async function switchToInstalledProject(result) {
  await refreshState();
  if (result.projectId) {
    const sw = result.sessions ? result : await window.assistantClient.switchProject(result.projectId);
    const sessionId = sw?.sessions?.[0]?.id;
    if (sessionId) await applySessionSwitch(sw, sessionId, result.projectId);
    expandProjectGroup(result.projectId);
  }
  renderProjectTree();
  updateTopbarTitles();
}

async function installWorkspaceApp(app, button) {
  if (typeof window.assistantClient.installWorkspaceApp !== "function") {
    showToast(t("toast.appInstallFailed"), "error");
    return;
  }
  if (button) button.disabled = true;
  try {
    const result = await window.assistantClient.installWorkspaceApp(app);
    if (!result?.ok) {
      if (result?.canceled) return;
      if (result?.failedDependencies) {
        const parts = [];
        if (result.failedDependencies.skills?.length) {
          parts.push(t("apps.failedSkills", { items: result.failedDependencies.skills.map((item) => item.id).join(", ") }));
        }
        if (result.failedDependencies.runtimePacks?.length) {
          parts.push(t("apps.failedRuntimePacks", { items: result.failedDependencies.runtimePacks.map((item) => item.id).join(", ") }));
        }
        showToast(parts.join(" · ") || t("toast.appInstallFailed"), "error");
        return;
      }
      showToast(result?.error || t("toast.appInstallFailed"), "error");
      return;
    }

    await switchToInstalledProject(result);

    if (result.missingSkills?.length || result.missingRuntimePacks?.length) {
      const parts = [];
      if (result.missingSkills?.length) parts.push(t("apps.missingSkills", { items: result.missingSkills.join(", ") }));
      if (result.missingRuntimePacks?.length) parts.push(t("apps.missingRuntimePacks", { items: result.missingRuntimePacks.join(", ") }));
      showToast(parts.join(" · "), "warning");
      return;
    }
    showToast(t("toast.appInstallDone", {
      name: result.projectName || app.name || "",
      path: result.workspacePath || result.installedApp?.path || "",
    }), "success");
    await refreshWorkspaceApps();
  } catch (err) {
    showToast(err?.message || t("toast.appInstallFailed"), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function openInstalledWorkspaceApp(app, button) {
  if (button) button.disabled = true;
  try {
    const result = await window.assistantClient.openInstalledWorkspaceApp(app.id);
    if (!result?.ok) {
      showToast(result?.error || t("toast.appOpenFailed"), "error");
      return;
    }
    await switchToInstalledProject(result);
  } catch (err) {
    showToast(err?.message || t("toast.appOpenFailed"), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function uninstallWorkspaceApp(app, button) {
  if (!window.confirm(t("apps.uninstallConfirm", { name: app.name || app.id }))) return;
  if (button) button.disabled = true;
  try {
    const result = await window.assistantClient.uninstallWorkspaceApp(app.id);
    if (!result?.ok) {
      showToast(result?.error || t("toast.appUninstallFailed"), "error");
      return;
    }
    await refreshState();
    renderProjectTree();
    updateTopbarTitles();
    await refreshWorkspaceApps();
    showToast(t("toast.appUninstallDone", { name: app.name || app.id }), "success");
  } catch (err) {
    showToast(err?.message || t("toast.appUninstallFailed"), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function updateCatalogHint(catalog) {
  const hint = $("workspaceAppsHint");
  if (!hint) return;
  if (!catalog?.ok) {
    hint.textContent = t("apps.catalogUnavailable");
    return;
  }
  const data = catalog.json || {};
  const parts = [];
  if (data.publisher) parts.push(data.publisher);
  if (data.updatedAt) {
    parts.push(t("apps.catalogChecked", { time: new Date(data.updatedAt).toLocaleString(getLocale()) }));
  }
  parts.push(t("apps.catalogCount", { count: (data.apps || []).length }));
  hint.textContent = parts.join(" · ");
}

function renderCatalog(catalog) {
  lastCatalog = catalog;
  updateCatalogHint(catalog);
  const apps = catalog?.json?.apps || [];
  if (!catalog?.ok) {
    renderEmpty(t("apps.catalogUnavailable"));
    return;
  }
  if (!apps.length) {
    renderEmpty(t("apps.empty"));
    return;
  }
  const list = $("workspaceAppsList");
  if (!list) return;
  list.replaceChildren();
  for (const app of apps) list.append(renderAppCard(app));
}

export async function refreshWorkspaceApps() {
  const list = $("workspaceAppsList");
  if (!list) return;
  try {
    const result = await window.assistantClient.listWorkspaceApps();
    renderCatalog(result);
  } catch {
    renderCatalog({ ok: false });
  }
}

export function initWorkspaceApps() {
  $("workspaceAppsRefreshBtn")?.addEventListener("click", async () => {
    const btn = $("workspaceAppsRefreshBtn");
    if (btn) btn.disabled = true;
    await refreshWorkspaceApps();
    if (btn) btn.disabled = false;
    showToast(lastCatalog?.ok ? t("toast.appsRefreshed") : t("toast.appsRefreshFailed"), lastCatalog?.ok ? "success" : "error");
  });
  void refreshWorkspaceApps();
}
