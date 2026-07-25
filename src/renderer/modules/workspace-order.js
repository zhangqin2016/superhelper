/**
 * Delegated sidebar workspace ordering interaction controller.
 */

import {
  commitWorkspaceOrder,
  isWorkspaceOrderCommitPending,
  moveWorkspaceByDelta,
  moveWorkspaceIds,
} from "./workspace-order-model.js";

export {
  canReorderWorkspaces,
  commitWorkspaceOrder,
  moveWorkspaceByDelta,
  moveWorkspaceIds,
  orderProjectsByIds,
  reorderKnownProjectSlots,
} from "./workspace-order-model.js";

const HOLD_MS = 250;
const HOLD_SLOP_PX = 4;
const EDGE_PX = 28;
const CLICK_SUPPRESS_MS = 600;

let activeController = null;

function sameOrder(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function createController(deps, owner) {
  const tree = deps.getTree?.() || deps.tree || null;
  const view = deps.window || globalThis.window;
  const doc = tree?.ownerDocument || globalThis.document;
  let candidate = null;
  let active = null;
  let holdTimer = null;
  let autoScrollFrame = null;
  let suppressedClick = null;
  let suppressClickTimer = null;
  let orderRevision = 0;
  let undoToast = null;
  let disposed = false;

  function isFilterActive() {
    if (typeof deps.isFilterActive === "function") {
      return Boolean(deps.isFilterActive());
    }
    return tree?.dataset?.filterActive === "true";
  }

  function translate(key, params) {
    return typeof deps.t === "function" ? deps.t(key, params) : key;
  }

  function clearHoldTimer() {
    if (holdTimer === null) return;
    clearTimeout(holdTimer);
    holdTimer = null;
  }

  function clearAutoScroll() {
    if (autoScrollFrame === null) return;
    const cancel = view?.cancelAnimationFrame || globalThis.cancelAnimationFrame;
    cancel?.(autoScrollFrame);
    autoScrollFrame = null;
  }

  function visibleGroups() {
    if (!tree) return [];
    return [...tree.querySelectorAll(".project-group")].filter((group) => {
      if (group.parentElement !== tree || group.style.display === "none") return false;
      const rect = group.getBoundingClientRect();
      return rect.height > 0;
    });
  }

  function placeMarker(clientY) {
    if (!active || !tree) return;
    const remaining = visibleGroups().filter((group) => group !== active.sourceGroup);
    let targetIndex = remaining.length;
    for (let index = 0; index < remaining.length; index += 1) {
      const rect = remaining[index].getBoundingClientRect();
      if (clientY < rect.top + (rect.height / 2)) {
        targetIndex = index;
        break;
      }
    }

    active.targetIndex = targetIndex;
    const reference = remaining[targetIndex] || null;
    tree.insertBefore(active.marker, reference);
  }

  function runAutoScroll() {
    autoScrollFrame = null;
    if (!active || !tree) return;
    const rect = tree.getBoundingClientRect();
    let delta = 0;
    if (active.clientY < rect.top + EDGE_PX) {
      delta = -Math.max(4, Math.ceil((rect.top + EDGE_PX - active.clientY) / 3));
    } else if (active.clientY > rect.bottom - EDGE_PX) {
      delta = Math.max(4, Math.ceil((active.clientY - (rect.bottom - EDGE_PX)) / 3));
    }
    if (!delta) return;

    const before = tree.scrollTop;
    tree.scrollTop += delta;
    if (tree.scrollTop === before) return;
    placeMarker(active.clientY);
    const raf = view?.requestAnimationFrame || globalThis.requestAnimationFrame;
    autoScrollFrame = raf?.(runAutoScroll) ?? null;
  }

  function scheduleAutoScroll() {
    if (autoScrollFrame !== null || !active || !tree) return;
    const rect = tree.getBoundingClientRect();
    const nearEdge = active.clientY < rect.top + EDGE_PX || active.clientY > rect.bottom - EDGE_PX;
    if (!nearEdge) return;
    const raf = view?.requestAnimationFrame || globalThis.requestAnimationFrame;
    autoScrollFrame = raf?.(runAutoScroll) ?? null;
  }

  function releasePointerCapture(drag) {
    if (!drag?.captureTarget || !drag.captureTarget.releasePointerCapture) return;
    try {
      if (!drag.captureTarget.hasPointerCapture || drag.captureTarget.hasPointerCapture(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // Pointer capture may already have been released by the browser.
    }
  }

  function cancelCandidate(pointerId) {
    if (!candidate || (pointerId !== undefined && pointerId !== candidate.pointerId)) return false;
    const canceled = candidate;
    candidate = null;
    clearHoldTimer();
    releasePointerCapture(canceled);
    return true;
  }

  function clearSuppressedClick() {
    suppressedClick = null;
    if (suppressClickTimer !== null) {
      clearTimeout(suppressClickTimer);
      suppressClickTimer = null;
    }
  }

  function suppressSourceClick(sourceId) {
    clearSuppressedClick();
    suppressedClick = {
      sourceId,
      expiresAt: Date.now() + CLICK_SUPPRESS_MS,
    };
    suppressClickTimer = setTimeout(clearSuppressedClick, CLICK_SUPPRESS_MS);
  }

  function resetDrag({ suppressClick = false } = {}) {
    clearHoldTimer();
    clearAutoScroll();
    cancelCandidate();
    if (!active) return;

    const finished = active;
    active = null;
    releasePointerCapture(finished);
    finished.marker.remove();
    finished.sourceGroup.classList.remove("is-dragging");
    tree?.classList.remove("workspace-ordering");
    if (suppressClick) suppressSourceClick(finished.sourceId);
  }

  async function commitAndNotify(nextIds) {
    const result = await commitWorkspaceOrder(nextIds, deps);
    if (!result.ok) {
      deps.showToast?.(translate("toast.workspaceOrderFailed"), "error");
      return result;
    }

    orderRevision += 1;
    const revision = orderRevision;
    const resultIds = (deps.getProjects?.() || []).map((project) => project.id);
    undoToast?.remove?.();
    undoToast = deps.showActionToast?.(
      translate("toast.workspaceOrderSaved"),
      translate("common.undo"),
      async () => {
        const currentIds = (deps.getProjects?.() || []).map((project) => project.id);
        if (disposed || revision !== orderRevision || !sameOrder(currentIds, resultIds)) {
          return { ok: false, error: "WORKSPACE_ORDER_UNDO_STALE" };
        }
        const undoResult = await commitWorkspaceOrder(result.previousIds, deps);
        if (!undoResult.ok) {
          deps.showToast?.(translate("toast.workspaceOrderFailed"), "error");
          return { ok: false, error: undoResult.error };
        }
        orderRevision += 1;
        undoToast = null;
        return undoResult;
      },
      "success",
      5000,
    );
    return result;
  }

  async function command(projectId, commandName) {
    if (isFilterActive()) {
      return { ok: false, error: "WORKSPACE_ORDER_FILTER_ACTIVE" };
    }
    if (isWorkspaceOrderCommitPending(deps)) {
      return { ok: false, error: "WORKSPACE_ORDER_BUSY" };
    }
    if (!["top", "up", "down"].includes(commandName)) {
      return { ok: false, error: "INVALID_WORKSPACE_ORDER_COMMAND" };
    }

    const ids = (deps.getProjects?.() || []).map((project) => project.id);
    const index = ids.indexOf(projectId);
    if (index < 0) return { ok: false, error: "WORKSPACE_NOT_FOUND" };

    const nextIds = commandName === "top"
      ? moveWorkspaceIds(ids, projectId, 0)
      : moveWorkspaceByDelta(ids, projectId, commandName === "up" ? -1 : 1);
    if (sameOrder(ids, nextIds)) return { ok: false, error: "NO_ORDER_CHANGE" };
    return commitAndNotify(nextIds);
  }

  function activateDrag(event) {
    if (!candidate || active) return;
    if (isFilterActive() || isWorkspaceOrderCommitPending(deps)) {
      cancelCandidate();
      return;
    }
    const sourceGroup = candidate.group;
    const groups = visibleGroups();
    const originalIndex = groups.indexOf(sourceGroup);
    if (originalIndex < 0) {
      cancelCandidate();
      return;
    }

    clearHoldTimer();
    const marker = doc.createElement("div");
    marker.className = "workspace-order-marker";
    marker.setAttribute("aria-hidden", "true");
    active = {
      pointerId: candidate.pointerId,
      sourceGroup,
      sourceId: sourceGroup.dataset.projectId,
      originalIndex,
      targetIndex: originalIndex,
      marker,
      captureTarget: candidate.captureTarget,
      clientY: event.clientY,
    };
    candidate = null;

    tree.classList.add("workspace-ordering");
    sourceGroup.classList.add("is-dragging");
    placeMarker(event.clientY);
    scheduleAutoScroll();
    event.preventDefault?.();
  }

  function beginCandidate(event, group, immediate) {
    cancelCandidate();
    candidate = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      group,
      captureTarget: event.target,
    };
    try {
      candidate.captureTarget?.setPointerCapture?.(candidate.pointerId);
    } catch {
      // Some synthetic or already-ended pointers cannot be captured.
    }
    if (immediate) {
      activateDrag(event);
      return;
    }
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (!candidate) return;
      activateDrag({
        clientY: candidate.startY,
        preventDefault() {},
      });
    }, HOLD_MS);
  }

  function onPointerDown(event) {
    if (disposed || active || isFilterActive() || isWorkspaceOrderCommitPending(deps)) return;
    if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;

    const handle = event.target.closest?.(".workspace-drag-handle");
    const headerMain = event.target.closest?.(".project-header-main");
    const header = event.target.closest?.(".project-header");
    const group = header?.closest?.(".project-group");
    if (!header || !group || group.parentElement !== tree) return;

    if (handle) {
      beginCandidate(event, group, true);
      return;
    }
    if (headerMain) {
      beginCandidate(event, group, false);
      return;
    }
    if (event.target.closest?.("button, a, input, textarea, select, [contenteditable='true'], [role='button']")) {
      return;
    }
    beginCandidate(event, group, false);
  }

  function onPointerMove(event) {
    if (active) {
      if (event.pointerId !== active.pointerId) return;
      active.clientY = event.clientY;
      placeMarker(event.clientY);
      clearAutoScroll();
      scheduleAutoScroll();
      event.preventDefault?.();
      return;
    }
    if (!candidate || event.pointerId !== candidate.pointerId) return;
    const distance = Math.hypot(event.clientX - candidate.startX, event.clientY - candidate.startY);
    if (distance > HOLD_SLOP_PX) {
      cancelCandidate(event.pointerId);
    }
  }

  function onPointerUp(event) {
    if (candidate && event.pointerId === candidate.pointerId) {
      cancelCandidate(event.pointerId);
      return;
    }
    if (!active || event.pointerId !== active.pointerId) return;

    const drag = active;
    const ids = (deps.getProjects?.() || []).map((project) => project.id);
    const nextIds = moveWorkspaceIds(ids, drag.sourceId, drag.targetIndex);
    const changed = !sameOrder(ids, nextIds);
    resetDrag({ suppressClick: true });
    if (changed) void commitAndNotify(nextIds);
  }

  function onPointerCancel(event) {
    cancelCandidate(event.pointerId);
    if (active && (event.pointerId === undefined || event.pointerId === active.pointerId)) {
      resetDrag();
    }
  }

  function onLostPointerCapture(event) {
    if (candidate && event.pointerId === candidate.pointerId) {
      cancelCandidate(event.pointerId);
      return;
    }
    if (active && event.pointerId === active.pointerId) resetDrag();
  }

  function onClickCapture(event) {
    if (!suppressedClick) return;
    if (Date.now() > suppressedClick.expiresAt) {
      clearSuppressedClick();
      return;
    }
    const projectId = event.target.closest?.(".project-group")?.dataset?.projectId;
    if (projectId !== suppressedClick.sourceId) return;
    clearSuppressedClick();
    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();
  }

  function onKeyDown(event) {
    if (event.key === "Escape" && (candidate || active)) {
      event.preventDefault();
      onPointerCancel({});
      return;
    }
    if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    const header = event.target.closest?.(".project-header");
    const group = header?.closest?.(".project-group");
    if (!header || !group || group.parentElement !== tree || isFilterActive()) return;
    event.preventDefault();
    void command(group.dataset.projectId, event.key === "ArrowUp" ? "up" : "down");
  }

  function onFilterChange() {
    if (isFilterActive()) onPointerCancel({});
  }

  function onWindowBlur() {
    onPointerCancel({});
  }

  tree?.addEventListener("pointerdown", onPointerDown);
  tree?.addEventListener("pointermove", onPointerMove);
  tree?.addEventListener("pointerup", onPointerUp);
  tree?.addEventListener("pointercancel", onPointerCancel);
  tree?.addEventListener("lostpointercapture", onLostPointerCapture);
  tree?.addEventListener("click", onClickCapture, true);
  tree?.addEventListener("keydown", onKeyDown);
  tree?.addEventListener("workspace-filter-change", onFilterChange);
  view?.addEventListener?.("blur", onWindowBlur);

  return {
    owner,
    command,
    dispose() {
      if (disposed) return;
      disposed = true;
      onPointerCancel({});
      clearHoldTimer();
      clearAutoScroll();
      clearSuppressedClick();
      undoToast?.remove?.();
      undoToast = null;
      orderRevision += 1;
      tree?.classList.remove("workspace-ordering");
      tree?.querySelectorAll(".is-dragging").forEach((group) => group.classList.remove("is-dragging"));
      tree?.querySelectorAll(".workspace-order-marker").forEach((marker) => marker.remove());
      tree?.removeEventListener("pointerdown", onPointerDown);
      tree?.removeEventListener("pointermove", onPointerMove);
      tree?.removeEventListener("pointerup", onPointerUp);
      tree?.removeEventListener("pointercancel", onPointerCancel);
      tree?.removeEventListener("lostpointercapture", onLostPointerCapture);
      tree?.removeEventListener("click", onClickCapture, true);
      tree?.removeEventListener("keydown", onKeyDown);
      tree?.removeEventListener("workspace-filter-change", onFilterChange);
      view?.removeEventListener?.("blur", onWindowBlur);
      if (activeController?.owner === owner) activeController = null;
    },
  };
}

export function initWorkspaceOrder(deps = {}) {
  const owner = Symbol("workspace-order-controller");
  activeController?.dispose();
  const controller = createController(deps, owner);
  activeController = controller;
  return controller;
}

export async function reorderWorkspaceByCommand(projectId, command) {
  if (!activeController) {
    return { ok: false, error: "WORKSPACE_ORDER_NOT_INITIALIZED" };
  }
  return activeController.command(projectId, command);
}
