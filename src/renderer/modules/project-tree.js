/**
 * Project tree — renders workspaces with nested sessions in the left panel.
 */

import store from "./state.js";
import { $ } from "./dom.js";
import { t } from "../i18n/index.js";
import { refreshState, updateTopbarTitles, applySessionSwitch } from "./session-chrome.js";
import { removeSessionMessages } from "./message.js";
import { promptSessionName, promptProjectName } from "./name-prompt.js";
import { showToast } from "./toast.js";
import { isSessionRunning, getSessionAttention } from "./session-runtime-store.js";

const container = () => $("projectTree");

// Which projects are collapsed
const collapsed = new Set();

/** Expand a project's session list (e.g. after creating a session). */
export function expandProjectGroup(projectId) {
  if (projectId) collapsed.delete(projectId);
}

function afterSessionListChanged(projectId) {
  expandProjectGroup(projectId);
  renderProjectTree();
}

async function createNamedSession(projectId, defaultTitle) {
  const title = await promptSessionName(defaultTitle || t("prompt.newSession"));
  if (!title) return null;
  return window.assistantClient.createSession(title, projectId);
}

async function renameSessionById(sessionId, currentTitle) {
  const newTitle = await promptSessionName(currentTitle);
  if (!newTitle || newTitle === currentTitle) return false;
  const result = await window.assistantClient.renameSession(sessionId, newTitle);
  if (result.ok) {
    await refreshState();
    renderProjectTree();
    updateTopbarTitles();
  }
  return result.ok;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function workspaceSkillRiskLabel(warning) {
  const value = warning?.value ? `: ${warning.value}` : "";
  if (warning?.kind === "domain") return `${t("pack.skillRiskDomain")}${value}`;
  if (warning?.kind === "credential-term") return `${t("pack.skillRiskCredential")}${value}`;
  if (warning?.kind === "secret") return `${t("pack.skillRiskSecret")}${value}`;
  if (warning?.kind === "workspace-identity") return `${t("pack.skillRiskIdentity")}${value}`;
  return warning?.label || t("pack.skillRiskUnknown");
}

function exportCategoryLabel(category) {
  const key = `pack.exportCategory.${category}`;
  const label = t(key);
  return label === key ? category : label;
}

function confirmWorkspacePackExport(info, sizeMb) {
  return new Promise((resolve) => {
    const workspaceSkills = Array.isArray(info.workspaceSkills) ? info.workspaceSkills : [];
    const riskySkills = workspaceSkills.filter((skill) => Array.isArray(skill.riskWarnings) && skill.riskWarnings.length);
    const overlay = document.createElement("section");
    overlay.className = "modal-panel workspace-export-panel";

    const card = document.createElement("div");
    card.className = "modal-card workspace-export-card";
    overlay.appendChild(card);

    const header = document.createElement("header");
    header.className = "modal-header";
    const titleWrap = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = t("pack.exportConfirmTitle");
    const lead = document.createElement("p");
    lead.textContent = t("pack.exportConfirmBody", { count: info.preview.fileCount, size: sizeMb });
    titleWrap.append(title, lead);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "topbar-btn";
    closeBtn.textContent = t("prompt.cancel");
    header.append(titleWrap, closeBtn);
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "workspace-export-body";
    card.appendChild(body);

    if (info.requiredSkills?.length) {
      const required = document.createElement("p");
      required.className = "workspace-export-note";
      required.textContent = t("pack.requiredSkills", { count: info.requiredSkills.length });
      body.appendChild(required);
    }

    const categorySummary = Array.isArray(info.preview?.categorySummary) ? info.preview.categorySummary : [];
    if (categorySummary.length) {
      const planSection = document.createElement("section");
      planSection.className = "workspace-export-data workspace-export-plan";
      const planTitle = document.createElement("h3");
      planTitle.textContent = t("pack.exportPlanTitle");
      const planIntro = document.createElement("p");
      planIntro.textContent = t("pack.exportPlanIntro");
      const planList = document.createElement("div");
      planList.className = "workspace-export-data-list";
      for (const item of categorySummary.slice(0, 8)) {
        const chip = document.createElement("span");
        chip.textContent = t("pack.exportPlanItem", {
          category: exportCategoryLabel(item.category),
          count: item.fileCount || 0,
          size: formatBytes(item.totalBytes || 0),
        });
        planList.appendChild(chip);
      }
      planSection.append(planTitle, planIntro, planList);
      body.appendChild(planSection);
    }

    const skippedFileCount = Number(info.preview?.skippedFileCount || 0);
    if (skippedFileCount > 0) {
      const skipped = document.createElement("div");
      skipped.className = "workspace-export-warning";
      const examples = (info.preview?.skippedFiles || [])
        .slice(0, 5)
        .map((file) => file.relPath)
        .join(", ");
      skipped.textContent = t("pack.skippedFilesWarning", {
        count: skippedFileCount,
        size: formatBytes(info.preview?.limits?.maxFileBytes || 0),
        files: examples || "-",
      });
      body.appendChild(skipped);
    }

    if (info.preview?.truncated) {
      const truncated = document.createElement("div");
      truncated.className = "workspace-export-warning";
      truncated.textContent = t("pack.truncatedWarning", {
        count: info.preview?.limits?.maxTotalFiles || 0,
      });
      body.appendChild(truncated);
    }

    const appDataPaths = Array.isArray(info.preview?.appDataPaths) ? info.preview.appDataPaths : [];
    if (appDataPaths.length) {
      const dataSection = document.createElement("section");
      dataSection.className = "workspace-export-data";
      const dataTitle = document.createElement("h3");
      dataTitle.textContent = t("pack.appDataTitle");
      const dataIntro = document.createElement("p");
      dataIntro.textContent = t("pack.appDataIntro");
      const dataList = document.createElement("div");
      dataList.className = "workspace-export-data-list";
      for (const dataPath of appDataPaths) {
        const item = document.createElement("span");
        item.textContent = t("pack.appDataItem", {
          path: dataPath.path,
          count: dataPath.fileCount || 0,
          size: formatBytes(dataPath.totalBytes || 0),
        });
        dataList.appendChild(item);
      }
      dataSection.append(dataTitle, dataIntro, dataList);
      body.appendChild(dataSection);
    }

    const fileWarnings = info.preview.secretWarnings || [];
    if (fileWarnings.length) {
      const warn = document.createElement("div");
      warn.className = "workspace-export-warning";
      warn.textContent = t("pack.secretWarning", {
        count: fileWarnings.length,
        files: fileWarnings.slice(0, 5).map((w) => w.relPath).join(", "),
      });
      body.appendChild(warn);
    }

    const skillSection = document.createElement("section");
    skillSection.className = "workspace-export-skills";
    const skillTitle = document.createElement("h3");
    skillTitle.textContent = t("pack.workspaceSkillsTitle");
    const skillIntro = document.createElement("p");
    skillIntro.textContent = workspaceSkills.length
      ? t("pack.workspaceSkillsIntro")
      : t("pack.noWorkspaceSkills");
    skillSection.append(skillTitle, skillIntro);

    if (workspaceSkills.length) {
      const list = document.createElement("div");
      list.className = "workspace-export-skill-list";
      for (const skill of workspaceSkills) {
        const item = document.createElement("article");
        item.className = `workspace-export-skill${skill.riskWarnings?.length ? " has-risk" : ""}`;
        const itemHead = document.createElement("div");
        itemHead.className = "workspace-export-skill-head";
        const name = document.createElement("strong");
        name.textContent = skill.name || skill.id;
        const meta = document.createElement("span");
        meta.textContent = `${skill.id} · v${skill.version || "0.1.0"} · ${t("pack.skillFiles", { count: skill.fileCount || 0, size: formatBytes(skill.totalBytes) })}`;
        itemHead.append(name, meta);
        item.appendChild(itemHead);

        if (skill.riskWarnings?.length) {
          const riskTitle = document.createElement("div");
          riskTitle.className = "workspace-export-risk-title";
          riskTitle.textContent = t("pack.skillWarningTitle");
          item.appendChild(riskTitle);
          const risks = document.createElement("ul");
          risks.className = "workspace-export-risk-list";
          for (const warning of skill.riskWarnings.slice(0, 8)) {
            const li = document.createElement("li");
            const path = warning.relPath ? ` (${warning.relPath})` : "";
            li.textContent = `${workspaceSkillRiskLabel(warning)}${path}`;
            risks.appendChild(li);
          }
          item.appendChild(risks);
        }
        list.appendChild(item);
      }
      skillSection.appendChild(list);
    }
    body.appendChild(skillSection);

    const includeRow = document.createElement("label");
    includeRow.className = "workspace-export-include";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = false;
    checkbox.disabled = workspaceSkills.length === 0;
    const includeText = document.createElement("span");
    includeText.textContent = workspaceSkills.length
      ? t("pack.workspaceSkillsInclude")
      : t("pack.workspaceSkillsDefaultOff");
    includeRow.append(checkbox, includeText);
    body.appendChild(includeRow);

    if (riskySkills.length) {
      const risk = document.createElement("div");
      risk.className = "workspace-export-danger";
      risk.textContent = t("pack.workspaceSkillRiskSummary", { count: riskySkills.length });
      body.appendChild(risk);
    }

    const actions = document.createElement("div");
    actions.className = "workspace-export-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "topbar-btn";
    cancel.textContent = t("prompt.cancel");
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "send-btn";
    const updateConfirmText = () => {
      confirm.textContent = checkbox.checked
        ? t("pack.exportWithWorkspaceSkills")
        : t("pack.exportWithoutWorkspaceSkills");
    };
    updateConfirmText();
    actions.append(cancel, confirm);
    card.appendChild(actions);

    const finish = (value) => {
      overlay.remove();
      document.removeEventListener("keydown", onKeyDown);
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") finish(null);
    };

    checkbox.addEventListener("change", updateConfirmText);
    closeBtn.addEventListener("click", () => finish(null));
    cancel.addEventListener("click", () => finish(null));
    confirm.addEventListener("click", () => finish({ includeWorkspaceSkills: checkbox.checked }));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null);
    });

    document.body.appendChild(overlay);
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => confirm.focus());
  });
}

export function renderProjectTree() {
  const el = container();
  if (!el) return;
  el.textContent = "";

  const projects = store.get("projects") || [];
  const activeProjectId = store.get("activeProjectId");
  const activeSessionId = store.get("activeSessionId");
  const pinned = projects.filter((p) => p.pinned);
  const unpinned = projects.filter((p) => !p.pinned);
  const sorted = [...pinned, ...unpinned];

  if (sorted.length === 0) {
    const empty = document.createElement("div");
    empty.className = "project-tree-empty";
    empty.textContent = t("sidebar.emptyWorkspace");
    el.appendChild(empty);
    return;
  }

  for (const project of sorted) {
    const sessions = project.sessions || [];
    const isActive = project.id === activeProjectId;
    const isCollapsed = collapsed.has(project.id);

    const group = document.createElement("div");
    group.className = `project-group${isActive ? " active" : ""}`;
    group.dataset.projectId = project.id;

    const header = document.createElement("div");
    header.className = "project-header";
    header.addEventListener("click", (e) => {
      if (e.target.closest(".project-action-btn")) return;
      collapsed.has(project.id)
        ? collapsed.delete(project.id)
        : collapsed.add(project.id);
      renderProjectTree();
    });

    const icon = document.createElement("span");
    icon.className = "project-collapse-icon";
    icon.textContent = isCollapsed ? "▶" : "▼";

    const info = document.createElement("div");
    info.className = "project-info";

    const name = document.createElement("span");
    name.className = "project-name project-name-editable";
    name.textContent = project.name;
    name.title = t("sidebar.renameFolderHint");
    name.addEventListener("dblclick", async (e) => {
      e.stopPropagation();
      const newName = await promptProjectName(project.name);
      if (!newName || newName === project.name) return;
      await window.assistantClient.renameProject(project.id, newName);
      await refreshState();
      renderProjectTree();
      updateTopbarTitles();
    });

    info.append(name);

    const actions = document.createElement("div");
    actions.className = "project-actions";

    const newSessionBtn = document.createElement("button");
    newSessionBtn.className = "project-action-btn";
    newSessionBtn.title = t("sidebar.newSession");
    newSessionBtn.textContent = "+";
    newSessionBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const result = await createNamedSession(project.id);
      if (!result?.ok) {
        showToast(result?.detail || t("toast.createSessionFailed"), "error");
        return;
      }
      const sw = await window.assistantClient.switchSession(result.session.id);
      await refreshState();
      afterSessionListChanged(project.id);
      await applySessionSwitch(sw, result.session.id, project.id);
    });

    const moreBtn = document.createElement("button");
    moreBtn.className = "project-action-btn";
    moreBtn.title = t("sidebar.moreActions");
    moreBtn.textContent = "…";
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showProjectMenu(e, project);
    });

    actions.append(newSessionBtn, moreBtn);
    header.append(icon, info, actions);
    group.appendChild(header);

    const sessionList = document.createElement("div");
    sessionList.className = "project-sessions";
    if (isCollapsed) sessionList.style.display = "none";

    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "project-sessions-empty";
      empty.textContent = t("sidebar.noSessions");
      sessionList.appendChild(empty);
    } else {
      for (const s of sessions) {
        const item = document.createElement("div");
        item.className = `session-item${s.id === activeSessionId ? " active" : ""}`;
        item.dataset.sessionId = s.id;
        item.dataset.projectId = project.id;

        const status = document.createElement("span");
        status.className = "session-status";
        applySessionStatusDot(status, s.id);
        item.appendChild(status);

        const title = document.createElement("span");
        title.className = "session-title session-title-editable";
        title.textContent = s.title;
        title.title = t("sidebar.renameSessionHint");
        title.addEventListener("dblclick", async (e) => {
          e.stopPropagation();
          await renameSessionById(s.id, s.title);
        });
        item.appendChild(title);

        const meta = document.createElement("span");
        meta.className = "session-meta";
        meta.textContent = s.messageCount ? t("sidebar.messageCount", { count: s.messageCount }) : "";
        item.appendChild(meta);

        item.addEventListener("click", async () => {
          const visibleId = document.querySelector(".session-messages.is-active")?.dataset?.sessionId;
          if (s.id === store.get("activeSessionId") && s.id === visibleId) return;
          try {
            const sw = await window.assistantClient.switchSession(s.id);
            await applySessionSwitch(sw, s.id, project.id);
          } catch (err) {
            showToast(err?.message || t("toast.switchSessionFailed"), "error");
          }
        });

        item.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showSessionMenu(e.clientX, e.clientY, s.id, s.title);
        });

        sessionList.appendChild(item);
      }
    }

    group.appendChild(sessionList);

    el.appendChild(group);
  }
}

export function updateProjectTreeSelection() {
  const el = container();
  if (!el) return;
  const activeProjectId = store.get("activeProjectId");
  const activeSessionId = store.get("activeSessionId");

  el.querySelectorAll(".project-group").forEach((group) => {
    group.classList.toggle("active", group.dataset.projectId === activeProjectId);
  });

  el.querySelectorAll(".session-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.sessionId === activeSessionId);
  });
}

// Paint a session-list status dot. Precedence: running > finished-unviewed
// (done/failed) > idle. "done"/"failed" come from getSessionAttention, set when
// a background turn finishes and cleared when the user views the session.
function applySessionStatusDot(dot, sessionId) {
  const running = isSessionRunning(sessionId);
  const attention = running ? null : getSessionAttention(sessionId);
  dot.classList.toggle("running", running);
  dot.classList.toggle("done", attention === "done");
  dot.classList.toggle("error", attention === "failed");
  dot.classList.toggle("idle", !running && !attention);
  dot.title = running
    ? t("sidebar.processing")
    : attention === "done"
      ? t("sidebar.sessionDone")
      : attention === "failed"
        ? t("sidebar.sessionFailed")
        : "";
}

export function updateSessionRunningIndicators() {
  container()?.querySelectorAll(".session-item").forEach((item) => {
    const dot = item.querySelector(".session-status");
    if (dot) applySessionStatusDot(dot, item.dataset.sessionId);
  });
}

export function updateSessionMetaCounts() {
  const sessionById = new Map();
  for (const project of store.get("projects") || []) {
    for (const session of project.sessions || []) {
      sessionById.set(session.id, session);
    }
  }

  container()?.querySelectorAll(".session-item").forEach((item) => {
    const session = sessionById.get(item.dataset.sessionId);
    if (!session) return;
    const meta = item.querySelector(".session-meta");
    if (meta) meta.textContent = session.messageCount ? t("sidebar.messageCount", { count: session.messageCount }) : "";
  });
}

export function updateProjectTreeChrome() {
  updateProjectTreeSelection();
  updateSessionRunningIndicators();
  updateSessionMetaCounts();
}

const CTX_MENU_CSS = "position:fixed;z-index:10000;min-width:160px;padding:6px;background:var(--bg-floating);border:1px solid var(--border-light);border-radius:8px;box-shadow:var(--shadow-floating);";

// Place a context menu at (x, y) but flip/clamp it back inside the viewport —
// menus opened on the last list item used to overflow below the window and
// get clipped.
function placeContextMenu(menu, x, y) {
  document.body.appendChild(menu);
  const { width, height } = menu.getBoundingClientRect();
  const margin = 8;
  let left = x;
  let top = y;
  if (left + width > window.innerWidth - margin) left = Math.max(margin, x - width);
  if (top + height > window.innerHeight - margin) top = Math.max(margin, y - height);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function showProjectMenu(e, project) {
  const existing = document.querySelector(".ctx-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.cssText = CTX_MENU_CSS;

  const items = [
    {
      label: t("ctx.switchFolder"),
      action: async () => {
        await window.assistantClient.switchProject(project.id);
        await refreshState();
        renderProjectTree();
        updateTopbarTitles();
      },
    },
    {
      label: project.pinned ? t("ctx.unpin") : t("ctx.pin"),
      action: async () => {
        await window.assistantClient.pinProject(project.id);
        await refreshState();
        renderProjectTree();
      },
    },
    {
      label: t("ctx.rename"),
      action: async () => {
        const name = await promptProjectName(project.name);
        if (!name || name === project.name) return;
        await window.assistantClient.renameProject(project.id, name);
        await refreshState();
        renderProjectTree();
        updateTopbarTitles();
      },
    },
    {
      label: t("ctx.openInFinder"),
      action: () => window.assistantClient.openProject(project.id),
    },
    {
      label: t("ctx.sharePack"),
      action: () => shareWorkspacePack(project),
    },
    {
      label: t("ctx.delete"),
      danger: true,
      action: async () => {
        const result = await window.assistantClient.removeProject(project.id);
        if (result.ok) {
          const { hideAllSessionMessages } = await import("./message.js");
          hideAllSessionMessages();
          await refreshState();
          renderProjectTree();
          updateTopbarTitles();
        }
      },
    },
  ];

  for (const item of items) {
    const btn = document.createElement("button");
    btn.className = "ctx-menu-item";
    if (item.danger) btn.style.color = "#f87171";
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      menu.remove();
      item.action();
    });
    menu.appendChild(btn);
  }

  placeContextMenu(menu, e.clientX, e.clientY);

  const closeMenu = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener("click", closeMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", closeMenu), 0);
}

function showSessionMenu(x, y, sessionId, title) {
  const existing = document.querySelector(".ctx-menu");
  if (existing) existing.remove();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.style.cssText = CTX_MENU_CSS;

  const rename = document.createElement("button");
  rename.className = "ctx-menu-item";
  rename.textContent = t("ctx.rename");
  rename.addEventListener("click", async () => {
    menu.remove();
    await renameSessionById(sessionId, title);
  });

  const archive = document.createElement("button");
  archive.className = "ctx-menu-item";
  archive.textContent = t("ctx.archive");
  archive.addEventListener("click", async () => {
    menu.remove();
    await window.assistantClient.archiveSession(sessionId);
    await refreshState();
    renderProjectTree();
    updateTopbarTitles();
  });

  const del = document.createElement("button");
  del.className = "ctx-menu-item";
  del.style.color = "#f87171";
  del.textContent = t("ctx.delete");
  del.addEventListener("click", async () => {
    menu.remove();
    await window.assistantClient.deleteSession(sessionId);
    removeSessionMessages(sessionId);
    await refreshState();
    renderProjectTree();
    updateTopbarTitles();
  });

  menu.append(rename, archive, del);
  placeContextMenu(menu, x, y);

  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener("click", closeMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", closeMenu), 0);
}

// Export a workspace as a shareable capability pack: preview what travels
// (privacy is an informed choice), confirm, then write the zip.
async function shareWorkspacePack(project) {
  // A rejected IPC (e.g. main process not restarted after an update) must not
  // vanish silently — surface it so "nothing happened" never happens.
  try {
    if (typeof window.assistantClient.exportPackPreview !== "function") {
      showToast(t("toast.exportPackFailed"), "error");
      return;
    }
    const info = await window.assistantClient.exportPackPreview(project.id);
    if (!info?.ok) {
      showToast(info?.error || t("toast.exportPackFailed"), "error");
      return;
    }
    const sizeMb = (info.preview.totalBytes / (1024 * 1024)).toFixed(1);
    const confirmed = await confirmWorkspacePackExport(info, sizeMb);
    if (!confirmed) return;
    const result = await window.assistantClient.exportPack(project.id, confirmed);
    if (result?.ok) showToast(t("toast.exportPackDone"), "success");
    else if (!result?.canceled) showToast(result?.error || t("toast.exportPackFailed"), "error");
  } catch (err) {
    showToast(err?.message || t("toast.exportPackFailed"), "error");
  }
}

async function importWorkspacePack() {
  try {
    if (typeof window.assistantClient.importPack !== "function") {
      showToast(t("toast.importPackFailed"), "error");
      return;
    }
    const result = await window.assistantClient.importPack();
    if (!result?.ok) {
      if (!result?.canceled) showToast(result?.error || t("toast.importPackFailed"), "error");
      return;
    }
    await refreshState();
    // Land the user IN the imported workspace so it's obvious where it went.
    if (result.projectId) {
      const sw = await window.assistantClient.switchProject(result.projectId);
      const sessionId = sw?.sessions?.[0]?.id;
      if (sessionId) await applySessionSwitch(sw, sessionId, result.projectId);
      expandProjectGroup(result.projectId);
    }
    renderProjectTree();
    updateTopbarTitles();
    if (result.missingSkills?.length) {
      showToast(t("toast.importPackMissingSkills", { skills: result.missingSkills.join(", ") }), "warning");
    } else {
      showToast(t("toast.importPackDone", { name: result.projectName || "" }), "success");
    }
  } catch (err) {
    showToast(err?.message || t("toast.importPackFailed"), "error");
  }
}

async function addFolderWorkspace() {
  const result = await window.assistantClient.addProject();
  if (!result.ok) return;

  // Re-adding an existing folder just switches to it — say so, skip the
  // rename prompt (the workspace already has a name).
  if (result.existed) {
    await refreshState();
    renderProjectTree();
    updateTopbarTitles();
    showToast(t("toast.folderAlreadyWorkspace"), "info");
    return;
  }

  const project = (result.state?.projects || []).find(
    (p) => p.id === result.state.activeProjectId,
  );
  if (project) {
    const name = await promptProjectName(project.name);
    if (name && name !== project.name) {
      await window.assistantClient.renameProject(project.id, name);
    }
  }

  await refreshState();
  renderProjectTree();
  updateTopbarTitles();
}

export function initAddProject() {
  // The add-workspace button offers both ways to get a new workspace —
  // an existing folder, or an imported capability pack — in one menu, so
  // the header stays a single uncluttered button.
  $("addProjectBtn")?.addEventListener("click", (e) => {
    const existing = document.querySelector(".ctx-menu");
    if (existing) existing.remove();
    const rect = e.currentTarget.getBoundingClientRect();
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.style.cssText = CTX_MENU_CSS;
    for (const [label, action] of [
      [t("ctx.addFolder"), addFolderWorkspace],
      [t("ctx.importPack"), importWorkspacePack],
    ]) {
      const btn = document.createElement("button");
      btn.className = "ctx-menu-item";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        menu.remove();
        void action();
      });
      menu.appendChild(btn);
    }
    placeContextMenu(menu, rect.left, rect.bottom + 4);
    setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
  });
}

export function initTopbarSessionRename() {
  $("projectTitle")?.addEventListener("click", async () => {
    const sessionId = store.get("activeSessionId");
    if (!sessionId) return;

    const projects = store.get("projects") || [];
    let currentTitle = t("prompt.newSession");
    for (const project of projects) {
      const session = (project.sessions || []).find((s) => s.id === sessionId);
      if (session) {
        currentTitle = session.title;
        break;
      }
    }

    await renameSessionById(sessionId, currentTitle);
  });
}

const style = document.createElement("style");
style.textContent = `
  .ctx-menu-item {
    display:block;width:100%;padding:6px 12px;border:0;border-radius:4px;
    background:transparent;color:var(--text-primary);font-size:13px;text-align:start;cursor:pointer;
  }
  .ctx-menu-item:hover { background:var(--bg-surface-hover); }
  .project-name-editable { cursor: pointer; }
  .project-name-editable:hover { color: var(--accent); }
`;
document.head.appendChild(style);
