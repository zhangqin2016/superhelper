import store from "./state.js";
import { getLocale, onLocaleChange, t } from "../i18n/index.js";
import {
  peekSessionRuntimeStatus,
  subscribeRuntime,
} from "./session-runtime-store.js";
import { showToast } from "./toast.js";
import { latestSession } from "./workspace-switcher-model.js";
import { createWorkspaceSwitcherView } from "./workspace-switcher-view.js";

function noopController() {
  return {
    dispose() {},
    open() {},
    close() {},
    render() {},
    isOpen: () => false,
  };
}

function isNotFound(value) {
  const code = value?.error || value?.code || value?.detail || value?.message || "";
  return String(code).toUpperCase().includes("NOT_FOUND");
}

export function isElementActuallyVisible(element) {
  if (!element?.isConnected) return false;
  const view = element.ownerDocument?.defaultView;
  for (let current = element; current?.nodeType === Node.ELEMENT_NODE; current = current.parentElement) {
    if (current.hidden) return false;
    const style = view?.getComputedStyle?.(current);
    if (
      style?.display === "none"
      || style?.visibility === "hidden"
      || style?.visibility === "collapse"
    ) {
      return false;
    }
  }
  return true;
}

function isFocusable(element) {
  return Boolean(
    element
    && !element.disabled
    && isElementActuallyVisible(element),
  );
}

let activeController = null;
let activeControllerOwnerToken = null;

export function initWorkspaceSwitcher(injected = {}) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return noopController();
  }

  activeController?.dispose();

  const deps = {
    getProjects: () => store.get("projects") || [],
    getActiveProjectId: () => store.get("activeProjectId"),
    assistantClient: window.assistantClient,
    refreshState: async (...args) => {
      const module = await import("./session-chrome.js");
      return module.refreshState(...args);
    },
    renderProjectTree: async (...args) => {
      const module = await import("./project-tree.js");
      return module.renderProjectTree(...args);
    },
    updateTopbarTitles: async (...args) => {
      const module = await import("./session-chrome.js");
      return module.updateTopbarTitles(...args);
    },
    applySessionSwitch: async (...args) => {
      const module = await import("./session-chrome.js");
      return module.applySessionSwitch(...args);
    },
    getLocale,
    t,
    showToast,
    getSessionStatus: peekSessionRuntimeStatus,
    subscribeRuntime,
    onLocaleChange,
    now: () => Date.now(),
    ...injected,
  };

  const button = document.getElementById("workspaceSwitcherBtn");
  const overlay = document.getElementById("workspaceSwitcherOverlay");
  const dialog = document.getElementById("workspaceSwitcherDialog");
  const search = document.getElementById("workspaceSwitcherSearch");
  const closeButton = document.getElementById("workspaceSwitcherClose");
  const content = document.getElementById("workspaceSwitcherContent");
  const addProjectButton = document.getElementById("addProjectBtn");

  if (!button || !overlay || !dialog || !search || !closeButton || !content) {
    return noopController();
  }

  let disposed = false;
  let opener = null;
  let switchPending = false;
  let generation = 0;
  let operationRevision = 0;
  const ownerToken = Symbol("workspace-switcher-owner");
  const cleanup = [];

  const listen = (target, event, handler, options) => {
    target.addEventListener(event, handler, options);
    cleanup.push(() => target.removeEventListener(event, handler, options));
  };

  const projects = () => {
    const value = deps.getProjects();
    return Array.isArray(value) ? value : [];
  };

  const projectById = (projectId) =>
    projects().find((project) => project.id === projectId) || null;

  const sessionById = (project, sessionId) =>
    (project?.sessions || []).find((session) => session.id === sessionId) || null;

  const controllerOwnsRenderer = () =>
    !disposed
    && activeController === controller
    && activeControllerOwnerToken === ownerToken;

  const beginOperation = () => ({
    ownerToken,
    revision: ++operationRevision,
  });

  const operationIsCurrent = (operation) =>
    controllerOwnsRenderer()
    && operation?.ownerToken === ownerToken
    && operation.revision === operationRevision;

  const view = createWorkspaceSwitcherView({
    content,
    dialog,
    search,
    deps,
    projects,
    projectById,
    isDisposed: () => disposed,
    isOpen: () => !overlay.hidden,
  });

  function setPending(pending) {
    switchPending = pending;
    view.setPending(pending);
  }

  async function refreshUnavailable(operation) {
    if (!operationIsCurrent(operation)) return;
    await deps.refreshState();
    if (!operationIsCurrent(operation) || overlay.hidden) return;
    view.selectInitialProject(deps.getActiveProjectId());
    view.resetActiveTarget();
    view.render();
    deps.showToast(deps.t("workspaceCenter.unavailable"), "error");
    search.focus({ preventScroll: true });
  }

  async function activateSession(projectId, sessionId) {
    if (switchPending) return;
    const operation = beginOperation();
    const project = projectById(projectId);
    const session = sessionById(project, sessionId);
    const ownerGeneration = generation;
    if (!project || !session) {
      await refreshUnavailable(operation);
      return;
    }

    setPending(true);
    try {
      const result = await deps.assistantClient?.switchSession?.(sessionId);
      if (!operationIsCurrent(operation)) return;
      if (!result?.ok) {
        if (isNotFound(result)) {
          await refreshUnavailable(operation);
        } else {
          deps.showToast(result?.detail || deps.t("toast.switchSessionFailed"), "error");
        }
        return;
      }
      await deps.applySessionSwitch(result, sessionId, projectId);
      if (!operationIsCurrent(operation)) return;
      if (!overlay.hidden && generation === ownerGeneration) close();
    } catch (error) {
      if (!operationIsCurrent(operation)) return;
      if (isNotFound(error)) await refreshUnavailable(operation);
      else deps.showToast(error?.message || deps.t("toast.switchSessionFailed"), "error");
    } finally {
      if (operationIsCurrent(operation)) setPending(false);
    }
  }

  async function activateWorkspace(projectId) {
    if (switchPending) return;
    const project = projectById(projectId);
    const latest = latestSession(project);
    if (latest) {
      await activateSession(project.id, latest.id);
      return;
    }
    const operation = beginOperation();
    const ownerGeneration = generation;
    if (!project) {
      await refreshUnavailable(operation);
      return;
    }

    setPending(true);
    try {
      const result = await deps.assistantClient?.switchProject?.(project.id);
      if (!operationIsCurrent(operation)) return;
      if (!result?.ok) {
        if (isNotFound(result)) {
          await refreshUnavailable(operation);
        } else {
          deps.showToast(result?.detail || deps.t("toast.switchWorkspaceFailed"), "error");
        }
        return;
      }
      await deps.refreshState();
      if (!operationIsCurrent(operation)) return;
      await deps.renderProjectTree();
      if (!operationIsCurrent(operation)) return;
      await deps.updateTopbarTitles();
      if (!operationIsCurrent(operation)) return;
      if (!overlay.hidden && generation === ownerGeneration) close();
    } catch (error) {
      if (!operationIsCurrent(operation)) return;
      if (isNotFound(error)) await refreshUnavailable(operation);
      else deps.showToast(error?.message || deps.t("toast.switchWorkspaceFailed"), "error");
    } finally {
      if (operationIsCurrent(operation)) setPending(false);
    }
  }

  async function activateTarget(target) {
    if (!target || target.disabled || switchPending) return;
    const { targetType, projectId, sessionId } = target.dataset;
    if (targetType === "add") {
      close();
      addProjectButton?.click();
    } else if (targetType === "session") {
      await activateSession(projectId, sessionId);
    } else if (targetType === "workspace") {
      await activateWorkspace(projectId);
    }
  }

  function open() {
    if (disposed) return;
    if (!overlay.hidden) {
      search.focus({ preventScroll: true });
      return;
    }
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : button;
    generation += 1;
    search.value = "";
    view.resetActiveTarget();
    view.selectInitialProject(deps.getActiveProjectId());
    overlay.hidden = false;
    button.setAttribute("aria-expanded", "true");
    view.render();
    view.syncPendingUi();
    search.focus({ preventScroll: true });
    content.querySelector(".workspace-switcher-card.is-selected")
      ?.scrollIntoView?.({ block: "nearest" });
  }

  function close({ restoreFocus = true } = {}) {
    if (overlay.hidden) return;
    generation += 1;
    overlay.hidden = true;
    button.setAttribute("aria-expanded", "false");
    search.value = "";
    view.resetActiveTarget();
    if (restoreFocus) {
      const focusTarget = isFocusable(opener) ? opener : button;
      focusTarget?.focus?.({ preventScroll: true });
      if (document.activeElement !== focusTarget) {
        button.focus({ preventScroll: true });
      }
    }
    opener = null;
  }

  function focusableElements() {
    return [...dialog.querySelectorAll(
      'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
    )].filter(isFocusable);
  }

  function onOverlayKeydownCapture(event) {
    if (overlay.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!dialog.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onShortcutKeydown(event) {
    if (event.defaultPrevented) return;
    const shortcut = event.key.toLowerCase() === "k"
      && (event.metaKey || event.ctrlKey)
      && !event.altKey;
    if (!shortcut) return;
    const competingModal = [...document.querySelectorAll('[aria-modal="true"]')]
      .some((modal) => modal !== dialog && isElementActuallyVisible(modal));
    if (competingModal) return;
    event.preventDefault();
    open();
  }

  listen(button, "click", open);
  listen(closeButton, "click", () => close());
  listen(overlay, "click", (event) => {
    if (event.target === overlay) close();
  });
  listen(content, "click", (event) => {
    const target = event.target.closest(".workspace-switcher-target");
    if (target) void activateTarget(target);
  });
  listen(search, "input", () => {
    view.resetActiveTarget();
    view.render();
  });
  listen(search, "keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      view.moveActiveTarget(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      view.moveActiveTarget(-1);
    } else if (event.key === "Enter") {
      const target = view.activeTarget();
      if (target) {
        event.preventDefault();
        void activateTarget(target);
      }
    }
  });
  listen(document, "keydown", onOverlayKeydownCapture, true);
  listen(document, "keydown", onShortcutKeydown);

  const unsubscribeRuntime = deps.subscribeRuntime?.(view.patchRuntimeStatuses);
  const unsubscribeLocale = deps.onLocaleChange?.(() => {
    if (!overlay.hidden) view.render({ preserveActive: true });
  });

  const controller = {
    dispose() {
      if (disposed) return;
      operationRevision += 1;
      close({ restoreFocus: true });
      disposed = true;
      cleanup.splice(0).forEach((remove) => remove());
      unsubscribeRuntime?.();
      unsubscribeLocale?.();
      if (activeController === controller) {
        activeController = null;
        activeControllerOwnerToken = null;
      }
    },
    open,
    close,
    render: view.render,
    isOpen: () => !overlay.hidden,
  };
  activeController = controller;
  activeControllerOwnerToken = ownerToken;
  view.syncPendingUi();
  return controller;
}
