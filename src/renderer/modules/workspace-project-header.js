/**
 * Builds a workspace header while callers retain ownership of business actions.
 */

import { t } from "../i18n/index.js";

export function createWorkspaceProjectHeader({
  project,
  position,
  total,
  isCollapsed,
  onToggleCollapsed,
  onRename,
  onCreateSession,
  onShowMenu,
  onShowVersion,
}) {
  const header = document.createElement("div");
  header.className = "project-header";
  header.dataset.projectId = project.id;

  const headerMain = document.createElement("button");
  headerMain.type = "button";
  headerMain.className = "project-header-main";
  headerMain.dataset.projectId = project.id;
  headerMain.dataset.position = String(position);
  headerMain.dataset.total = String(total);
  headerMain.setAttribute("aria-expanded", String(!isCollapsed));
  headerMain.setAttribute("aria-label", t("workspaceOrder.position", {
    name: project.name,
    position,
    total,
  }));
  headerMain.addEventListener("click", () => {
    onToggleCollapsed({ restoreFocus: document.activeElement === headerMain });
  });

  const icon = document.createElement("span");
  icon.className = "project-collapse-icon";
  icon.textContent = isCollapsed ? "▶" : "▼";

  const info = document.createElement("span");
  info.className = "project-info";

  const name = document.createElement("span");
  name.className = "project-name project-name-editable";
  name.textContent = project.name;
  name.title = t("sidebar.renameFolderHint");
  name.addEventListener("dblclick", async (event) => {
    event.stopPropagation();
    await onRename();
  });

  info.append(name);
  headerMain.append(icon, info);

  const actions = document.createElement("div");
  actions.className = "project-actions";

  const dragHandle = document.createElement("button");
  dragHandle.type = "button";
  dragHandle.className = "workspace-drag-handle";
  dragHandle.title = t("workspaceOrder.dragHandle");
  dragHandle.setAttribute("aria-label", t("workspaceOrder.dragHandle"));
  const dragDots = document.createElement("span");
  dragDots.className = "workspace-drag-dots";
  dragDots.setAttribute("aria-hidden", "true");
  for (let dotIndex = 0; dotIndex < 6; dotIndex += 1) {
    const dot = document.createElement("span");
    dot.className = "workspace-drag-dot";
    dragDots.appendChild(dot);
  }
  dragHandle.appendChild(dragDots);
  dragHandle.addEventListener("click", (event) => event.stopPropagation());

  const newSessionBtn = document.createElement("button");
  newSessionBtn.className = "project-action-btn";
  newSessionBtn.title = t("sidebar.newSession");
  newSessionBtn.textContent = "+";
  newSessionBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    await onCreateSession();
  });

  const moreBtn = document.createElement("button");
  moreBtn.className = "project-action-btn";
  moreBtn.title = t("sidebar.moreActions");
  moreBtn.textContent = "…";
  moreBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    onShowMenu(event);
  });

  const versionBtn = document.createElement("button");
  versionBtn.type = "button";
  versionBtn.className = "project-action-btn workspace-version-entry is-loading";
  versionBtn.title = t("workspaceVersion.open");
  versionBtn.setAttribute("aria-label", t("workspaceVersion.open"));
  versionBtn.dataset.projectId = project.id;
  const versionGlyph = document.createElement("span");
  versionGlyph.className = "workspace-version-glyph";
  versionGlyph.setAttribute("aria-hidden", "true");
  versionBtn.appendChild(versionGlyph);
  versionBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    onShowVersion?.();
  });

  actions.append(newSessionBtn, moreBtn);
  header.append(headerMain, dragHandle, versionBtn, actions);
  return header;
}
