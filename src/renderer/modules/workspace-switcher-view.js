import {
  latestSession,
  recentSessions,
  searchWorkspaceTargets,
  sessionRelativeValue,
} from "./workspace-switcher-model.js";

const DEFAULT_RECENT_LIMIT = 3;

function createElement(tag, className, textContent = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent) node.textContent = textContent;
  return node;
}

function targetStatus(sessionId, deps) {
  if (!sessionId) return "idle";
  const { running = false, attention = null } = deps.getSessionStatus(sessionId) || {};
  if (running) return "running";
  if (attention === "done" || attention === "failed") return attention;
  return "idle";
}

export function createWorkspaceSwitcherView({
  content,
  dialog,
  search,
  deps,
  projects,
  projectById,
  isDisposed,
  isOpen,
}) {
  let selectedProjectId = null;
  let activeTargetKey = null;
  let switchPending = false;

  const statusLabel = (status) => deps.t(`workspaceCenter.status.${status}`);

  function relativeTime(session) {
    const relative = sessionRelativeValue(session, deps.now());
    if (!relative) return "";
    try {
      return new Intl.RelativeTimeFormat(deps.getLocale(), { numeric: "auto" })
        .format(relative.value, relative.unit);
    } catch {
      return "";
    }
  }

  function createStatusNode(sessionId) {
    const status = targetStatus(sessionId, deps);
    const node = createElement(
      "span",
      `workspace-switcher-session-status is-${status}`,
      statusLabel(status),
    );
    node.dataset.sessionId = sessionId || "";
    node.dataset.status = status;
    return node;
  }

  function patchRuntimeStatuses() {
    if (isDisposed()) return;
    content.querySelectorAll(".workspace-switcher-session-status[data-session-id]")
      .forEach((node) => {
        const status = targetStatus(node.dataset.sessionId, deps);
        node.dataset.status = status;
        node.className = `workspace-switcher-session-status is-${status}`;
        node.textContent = statusLabel(status);
      });
  }

  function decorateTarget(target, type, projectId, sessionId = "") {
    target.classList.add("workspace-switcher-target");
    target.dataset.targetType = type;
    target.dataset.projectId = projectId || "";
    target.dataset.sessionId = sessionId || "";
    target.dataset.targetKey = type === "workspace"
      ? `workspace:${projectId}`
      : type === "session"
        ? `session:${projectId}:${sessionId}`
        : "add";
    target.disabled = switchPending;
    return target;
  }

  function createSessionRow(project, session, className = "workspace-switcher-session-row") {
    const row = decorateTarget(
      createElement("button", className),
      "session",
      project.id,
      session.id,
    );
    row.type = "button";
    row.title = session.title || deps.t("workspaceCenter.untitledSession");

    const title = createElement(
      "span",
      "workspace-switcher-session-title",
      session.title || deps.t("workspaceCenter.untitledSession"),
    );
    const meta = createElement("span", "workspace-switcher-session-meta");
    const time = relativeTime(session);
    if (time) {
      meta.appendChild(createElement("span", "workspace-switcher-session-time", time));
    }
    meta.appendChild(createStatusNode(session.id));
    row.append(title, meta);
    return row;
  }

  function syncSelectedCards() {
    content.querySelectorAll(".workspace-switcher-card").forEach((card) => {
      const selected = card.dataset.projectId === selectedProjectId;
      card.classList.toggle("is-selected", selected);
      card.dataset.selected = selected ? "true" : "false";
    });
  }

  function createWorkspaceCard(project) {
    const latest = latestSession(project);
    const card = decorateTarget(
      createElement("button", "workspace-switcher-card"),
      "workspace",
      project.id,
      latest?.id || "",
    );
    card.type = "button";
    card.title = project.name || project.path || deps.t("workspaceCenter.untitledWorkspace");
    if (project.id === deps.getActiveProjectId()) card.setAttribute("aria-current", "true");

    const name = createElement(
      "span",
      "workspace-switcher-card-name",
      project.name || deps.t("workspaceCenter.untitledWorkspace"),
    );
    const latestTitle = createElement(
      "span",
      "workspace-switcher-card-session",
      latest?.title || deps.t("workspaceCenter.noSessions"),
    );
    if (latest?.title) latestTitle.title = latest.title;
    const meta = createElement("span", "workspace-switcher-card-meta");
    const time = latest ? relativeTime(latest) : "";
    if (time) meta.appendChild(createElement("span", "workspace-switcher-card-time", time));
    meta.appendChild(createStatusNode(latest?.id || ""));
    card.append(name, latestTitle, meta);
    return card;
  }

  function renderRecentPanel({ refreshTargetState = true } = {}) {
    const preservedTargetKey = activeTargetKey;
    const panel = content.querySelector(".workspace-switcher-recent-panel");
    if (!panel) return;
    panel.replaceChildren();
    const project = projectById(selectedProjectId);
    if (!project) return;

    const heading = createElement(
      "h3",
      "workspace-switcher-recent-title",
      deps.t("workspaceCenter.recentSessions", {
        name: project.name || deps.t("workspaceCenter.untitledWorkspace"),
      }),
    );
    const list = createElement("div", "workspace-switcher-recent-list");
    const sessions = recentSessions(project, DEFAULT_RECENT_LIMIT);
    if (sessions.length === 0) {
      list.appendChild(createElement(
        "p",
        "workspace-switcher-no-sessions",
        deps.t("workspaceCenter.noSessions"),
      ));
    } else {
      sessions.forEach((session) => {
        list.appendChild(createSessionRow(project, session));
      });
    }
    panel.append(heading, list);
    if (refreshTargetState) refreshTargets(preservedTargetKey);
  }

  function renderDefaultView() {
    const sourceProjects = projects();
    if (sourceProjects.length === 0) {
      const empty = createElement("div", "workspace-switcher-empty");
      empty.appendChild(createElement(
        "p",
        "workspace-switcher-empty-message",
        deps.t("workspaceCenter.empty"),
      ));
      const add = decorateTarget(
        createElement("button", "workspace-switcher-empty-action", deps.t("sidebar.addWorkspace")),
        "add",
        "",
      );
      add.type = "button";
      empty.appendChild(add);
      content.replaceChildren(empty);
      return;
    }

    if (!projectById(selectedProjectId)) {
      selectedProjectId = projectById(deps.getActiveProjectId())?.id || sourceProjects[0].id;
    }
    const grid = createElement("div", "workspace-switcher-grid");
    sourceProjects.forEach((project) => grid.appendChild(createWorkspaceCard(project)));
    const recentPanel = createElement("section", "workspace-switcher-recent-panel");
    content.replaceChildren(grid, recentPanel);
    syncSelectedCards();
    renderRecentPanel({ refreshTargetState: false });
  }

  function createGroup(titleKey, className) {
    const section = createElement("section", className);
    section.appendChild(createElement(
      "h3",
      "workspace-switcher-result-heading",
      deps.t(titleKey),
    ));
    return section;
  }

  function renderSearchView(query) {
    const results = searchWorkspaceTargets(projects(), query);
    if (results.workspaces.length === 0 && results.sessions.length === 0) {
      content.replaceChildren(createElement(
        "p",
        "workspace-switcher-no-results",
        deps.t("workspaceCenter.noResults"),
      ));
      return;
    }

    const fragment = document.createDocumentFragment();
    if (results.workspaces.length > 0) {
      const section = createGroup(
        "workspaceCenter.workspaces",
        "workspace-switcher-search-group workspace-switcher-search-workspaces",
      );
      const list = createElement("div", "workspace-switcher-search-list");
      results.workspaces.forEach((project) => {
        const latest = latestSession(project);
        const target = decorateTarget(
          createElement("button", "workspace-switcher-search-result"),
          "workspace",
          project.id,
          latest?.id || "",
        );
        target.type = "button";
        target.title = project.name || project.path || deps.t("workspaceCenter.untitledWorkspace");
        target.append(
          createElement(
            "span",
            "workspace-switcher-result-primary",
            project.name || deps.t("workspaceCenter.untitledWorkspace"),
          ),
          createElement(
            "span",
            "workspace-switcher-result-secondary",
            latest?.title || deps.t("workspaceCenter.noSessions"),
          ),
        );
        list.appendChild(target);
      });
      section.appendChild(list);
      fragment.appendChild(section);
    }
    if (results.sessions.length > 0) {
      const section = createGroup(
        "workspaceCenter.sessions",
        "workspace-switcher-search-group workspace-switcher-search-sessions",
      );
      const list = createElement("div", "workspace-switcher-search-list");
      results.sessions.forEach(({ project, session }) => {
        const row = createSessionRow(
          project,
          session,
          "workspace-switcher-search-result workspace-switcher-session-result",
        );
        row.appendChild(createElement(
          "span",
          "workspace-switcher-result-workspace",
          project.name || deps.t("workspaceCenter.untitledWorkspace"),
        ));
        list.appendChild(row);
      });
      section.appendChild(list);
      fragment.appendChild(section);
    }
    content.replaceChildren(fragment);
  }

  function currentQuery() {
    return String(search.value || "").trim();
  }

  function render({ preserveActive = false } = {}) {
    if (isDisposed() || !isOpen()) return;
    const preservedTargetKey = preserveActive ? activeTargetKey : null;
    if (!preserveActive) activeTargetKey = null;
    const query = currentQuery();
    if (query) renderSearchView(query);
    else renderDefaultView();
    refreshTargets(preservedTargetKey);
  }

  function targetElements() {
    return [...content.querySelectorAll(".workspace-switcher-target")]
      .filter((target) => !target.disabled);
  }

  function refreshTargets(targetKey = activeTargetKey) {
    const targets = targetElements();
    targets.forEach((target, index) => {
      target.id = `workspace-switcher-target-${index}`;
      target.classList.remove("is-keyboard-active");
    });
    const activeTarget = targetKey
      ? targets.find((target) => target.dataset.targetKey === targetKey)
      : null;
    if (activeTarget) {
      activeTargetKey = activeTarget.dataset.targetKey;
      search.setAttribute("aria-activedescendant", activeTarget.id);
      activeTarget.classList.add("is-keyboard-active");
    } else {
      activeTargetKey = null;
      search.removeAttribute("aria-activedescendant");
    }
  }

  function moveActiveTarget(delta) {
    const targets = targetElements();
    if (targets.length === 0) return;
    const currentIndex = targets.findIndex(
      (target) => target.dataset.targetKey === activeTargetKey,
    );
    const next = currentIndex < 0
      ? (delta < 0 ? targets.length - 1 : 0)
      : Math.max(0, Math.min(targets.length - 1, currentIndex + delta));
    activeTargetKey = targets[next].dataset.targetKey;
    refreshTargets(activeTargetKey);
    targets[next].scrollIntoView?.({ block: "nearest" });
  }

  function syncPendingUi() {
    dialog.setAttribute("aria-busy", switchPending ? "true" : "false");
    content.querySelectorAll(".workspace-switcher-target").forEach((target) => {
      target.disabled = switchPending;
    });
    refreshTargets(activeTargetKey);
  }

  return {
    activeTarget() {
      return targetElements().find(
        (target) => target.dataset.targetKey === activeTargetKey,
      ) || null;
    },
    moveActiveTarget,
    patchRuntimeStatuses,
    render,
    resetActiveTarget() {
      activeTargetKey = null;
      search.removeAttribute("aria-activedescendant");
    },
    selectInitialProject(activeProjectId) {
      const sourceProjects = projects();
      selectedProjectId = projectById(activeProjectId)?.id || sourceProjects[0]?.id || null;
    },
    setPending(pending) {
      switchPending = pending;
      syncPendingUi();
    },
    syncPendingUi,
  };
}
