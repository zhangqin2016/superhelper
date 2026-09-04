/**
 * WeChat's 多选: pick several messages, then forward or delete them together.
 *
 * The module owns the selection state AND its action bar, so the panel only
 * has to hand it a container and two callbacks. While selection is active the
 * timeline turns each message into a checkbox target instead of a normal row.
 */
import { t } from "../i18n/index.js";
import { confirmDialog } from "./confirm-dialog.js";

export function createMessageMultiSelect({ container = null, onForward = () => {}, onDelete = () => {}, onChange = () => {} } = {}) {
  let active = false;
  const chosen = new Set();

  const bar = document.createElement("div");
  bar.className = "collaboration-select-bar";
  bar.hidden = true;
  bar.setAttribute("role", "toolbar");
  const count = document.createElement("span");
  count.className = "collaboration-select-count";
  count.setAttribute("role", "status");
  count.setAttribute("aria-live", "polite");
  const forward = button("forward-selected", "collaboration.forward", () => {
    const ids = [...chosen];
    if (ids.length) onForward(ids);
  });
  const remove = button("delete-selected", "collaboration.deleteSelected", async () => {
    const ids = [...chosen];
    if (!ids.length) return;
    // Destructive, so it asks — and says plainly that this is not a recall.
    const ok = await confirmDialog({ title: t("collaboration.deleteSelected"),
      message: t("collaboration.confirmDeleteMessages", { count: String(ids.length) }), danger: true });
    if (ok && chosen.size) onDelete([...chosen]);
  }, true);
  const cancel = button("cancel-select", "collaboration.forwardCancel", () => api.exit());
  bar.append(count, forward, remove, cancel);
  // Above the composer: appended to the end it landed BELOW the input and was
  // clipped, which made the whole batch mode unusable.
  const composer = container?.querySelector?.(".collaboration-composer");
  if (composer && container?.insertBefore) container.insertBefore(bar, composer);
  else container?.append?.(bar);

  function button(action, key, onClick, danger = false) {
    const node = document.createElement("button");
    node.type = "button";
    node.dataset.action = action;
    node.className = "collaboration-select-action" + (danger ? " is-danger" : "");
    node.textContent = t(key);
    node.addEventListener("click", onClick);
    return node;
  }

  const paint = () => {
    bar.hidden = !active;
    const n = chosen.size;
    count.textContent = t("collaboration.selectedCount", { count: String(n) });
    forward.disabled = n === 0;
    remove.disabled = n === 0;
  };

  const api = {
    isActive: () => active,
    has: (id) => chosen.has(String(id || "")),
    count: () => chosen.size,
    ids: () => [...chosen],
    /** Enter selection mode, optionally with the message you right-clicked. */
    enter(id) {
      active = true;
      chosen.clear();
      if (id) chosen.add(String(id));
      paint();
      onChange();
    },
    toggle(id) {
      const key = String(id || "");
      if (!key || !active) return;
      if (chosen.has(key)) chosen.delete(key); else chosen.add(key);
      paint();
      onChange();
    },
    exit() {
      if (!active && !chosen.size) return;
      active = false;
      chosen.clear();
      paint();
      onChange();
    },
    /** Called after a batch acts, so the bar's labels follow the new state. */
    refresh() { paint(); },
    destroy() { bar.remove(); },
  };
  paint();
  return api;
}

/** 删除 on a single message: confirm, then hide it on THIS device only. Kept
 *  beside the batch action so both say the same thing about what delete means. */
export function createLocalDeleteAction({ hideMessages = () => {}, onDone = () => {} } = {}) {
  return async (message) => {
    const id = message?.id;
    if (!id) return;
    const ok = await confirmDialog({ title: t("collaboration.deleteMessage"),
      message: t("collaboration.confirmDeleteMessages", { count: "1" }), danger: true });
    if (!ok) return;
    hideMessages([id]);
    onDone();
  };
}
