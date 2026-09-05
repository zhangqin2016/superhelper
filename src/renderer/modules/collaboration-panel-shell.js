const MIN_WIDTH = 360;
const DEFAULT_WIDTH = 420;
/** Below this the panel holds one column at a time; at or above it the list and
 *  the thread sit side by side, the shape a desktop chat client has. A 380px
 *  list plus a thread that can still show a full bubble needs about this much. */
const TWO_PANE_WIDTH = 760;
/** The old cap was 560px, which made a side-by-side layout impossible to reach
 *  by dragging. The panel may now take most of the window, but never so much
 *  that the workbench beside it stops being usable. */
const MAX_WIDTH = 1240;
const WORKBENCH_MIN = 520;
const STORAGE_KEY = "lily.collaboration.panelWidth";

const widthCeiling = () => {
  const available = Number(window.innerWidth) || 0;
  if (!available) return MAX_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, available - WORKBENCH_MIN));
};
const clampWidth = (value) => Math.min(widthCeiling(), Math.max(MIN_WIDTH, Number(value) || DEFAULT_WIDTH));

export function initCollaborationPanelShell({
  shell = document.getElementById("appShell"),
  panel = document.getElementById("collaborationCenter"),
  toggle = document.getElementById("collaborationPanelToggle"),
  closeButton = document.getElementById("collaborationPanelClose"),
  backButton = document.getElementById("collaborationConversationBack"),
  home = document.getElementById("collaborationHome"),
  conversation = document.getElementById("collaborationConversation"),
  scrim = document.getElementById("collaborationPanelScrim"),
  resizeHandle = document.getElementById("collaborationResizeHandle"),
  storage = window.localStorage,
} = {}) {
  if (!shell || !panel) return null;
  // Detached: this renderer was opened with `?view=collaboration`, so the panel
  // IS the window. No docking, no overlay, no resize handle, no close button —
  // the window's own chrome does all of that.
  // A missing `location` (the controller tests stub `window`) means docked,
  // which is the right default: standalone has to be asked for explicitly.
  const standalone = (() => {
    try { return new URLSearchParams(window.location?.search || "").get("view") === "collaboration"; }
    catch { return false; }
  })();
  if (standalone) {
    shell.dataset.appView = "collaboration";
    panel.hidden = false;
    panel.dataset.collaborationPanes = "two";
    if (resizeHandle) resizeHandle.hidden = true;
    if (scrim) scrim.hidden = true;
    if (closeButton) closeButton.hidden = true;
    const detachButton = document.getElementById("collaborationPanelDetach");
    if (detachButton) detachButton.hidden = true;
    if (backButton) backButton.hidden = true;
    if (home) home.hidden = false;
    const status = document.getElementById("collaborationStatus");
    const search = document.getElementById("collaborationInboxSearch");
    if (status && search) search.after?.(status);
    return Object.freeze({
      openPanel() {}, closePanel() {}, isOpen: () => true,
      // A conversation opens beside the list, exactly as in the wide docked
      // panel; there is nothing to go back to because the list never left.
      setConversationOpen(value) {
        panel.classList.toggle("is-conversation-open", Boolean(value));
        if (conversation) conversation.hidden = !value;
        if (home) home.hidden = false;
      },
      destroy() {},
    });
  }
  if (!toggle) return null;
  let open = false;
  let dragging = false;
  let width = clampWidth(storage?.getItem?.(STORAGE_KEY));

  const mode = () => window.innerWidth >= 1120 ? "docked" : "overlay";
  // Docked only: an overlay panel covers the workbench, and splitting it in two
  // there would leave both halves narrow for no gain.
  const panes = () => (mode() === "docked" && width >= TWO_PANE_WIDTH ? "two" : "one");
  let conversationOpen = false;
  const applyPanes = () => {
    const sideBySide = panes() === "two";
    // In two panes the list stays: a conversation is opened BESIDE it, so the
    // selected row keeps its context and there is nothing to go back from.
    if (home) home.hidden = conversationOpen && !sideBySide;
    if (conversation) conversation.hidden = !conversationOpen;
    if (backButton) backButton.hidden = sideBySide;
  };
  const apply = () => {
    const nextMode = mode();
    shell.dataset.collaborationMode = nextMode;
    // A resize can cross the threshold, so the pane count is re-derived here
    // rather than only when a conversation opens.
    panel.dataset.collaborationPanes = panes();
    applyPanes();
    shell.style.setProperty("--collaboration-panel-w", `${width}px`);
    shell.classList.toggle("collaboration-panel-open", open);
    panel.hidden = !open;
    panel.setAttribute("role", nextMode === "overlay" ? "dialog" : "complementary");
    panel.setAttribute("aria-modal", nextMode === "overlay" && open ? "true" : "false");
    toggle.setAttribute("aria-expanded", String(open));
    if (scrim) scrim.hidden = !open || nextMode !== "overlay";
    if (resizeHandle) resizeHandle.hidden = !open || nextMode !== "docked";
  };
  // Focus moves INTO the panel (for Escape and screen readers) but onto the
  // panel itself, not its first button: that button is "detach", and a focus
  // ring on it was the first thing you saw every time the panel opened.
  const openPanel = () => { open = true; apply(); if (panel.tabIndex == null || panel.tabIndex < 0) panel.tabIndex = -1; requestAnimationFrame(() => panel.focus?.({ preventScroll: true })); };
  const closePanel = () => { if (!open) return; open = false; apply(); toggle.focus?.(); };
  const setConversationOpen = (value) => {
    conversationOpen = Boolean(value);
    panel.classList.toggle("is-conversation-open", conversationOpen);
    applyPanes();
    if (conversationOpen && panes() === "one") requestAnimationFrame(() => backButton?.focus?.());
  };
  const togglePanel = () => open ? closePanel() : openPanel();
  const keydown = (event) => { if (open && event.key === "Escape") { event.preventDefault(); closePanel(); } };
  const resize = () => apply();
  const pointerMove = (event) => {
    if (!dragging) return;
    width = clampWidth(document.documentElement.dir === "rtl" ? event.clientX : window.innerWidth - event.clientX);
    apply();
  };
  const pointerUp = () => { if (!dragging) return; dragging = false; resizeHandle?.classList.remove("active"); storage?.setItem?.(STORAGE_KEY, String(width)); };
  const pointerDown = (event) => { dragging = true; resizeHandle?.classList.add("active"); event.preventDefault(); };
  toggle.addEventListener("click", togglePanel);
  closeButton?.addEventListener("click", closePanel);
  scrim?.addEventListener("click", closePanel);
  backButton?.addEventListener("click", () => setConversationOpen(false));
  resizeHandle?.addEventListener("pointerdown", pointerDown);
  window.addEventListener("pointermove", pointerMove);
  window.addEventListener("pointerup", pointerUp);
  window.addEventListener("resize", resize);
  document.addEventListener("keydown", keydown);
  apply();
  setConversationOpen(false);
  return { openPanel, closePanel, setConversationOpen, isOpen: () => open, destroy() {
    toggle.removeEventListener("click", togglePanel); closeButton?.removeEventListener("click", closePanel); scrim?.removeEventListener("click", closePanel);
    resizeHandle?.removeEventListener("pointerdown", pointerDown); window.removeEventListener("pointermove", pointerMove); window.removeEventListener("pointerup", pointerUp); window.removeEventListener("resize", resize); document.removeEventListener("keydown", keydown);
  } };
}
