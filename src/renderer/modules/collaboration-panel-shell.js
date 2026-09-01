const MIN_WIDTH = 360;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 420;
const STORAGE_KEY = "lily.collaboration.panelWidth";

const clampWidth = (value) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Number(value) || DEFAULT_WIDTH));

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
  if (!shell || !panel || !toggle) return null;
  let open = false;
  let dragging = false;
  let width = clampWidth(storage?.getItem?.(STORAGE_KEY));

  const mode = () => window.innerWidth >= 1120 ? "docked" : "overlay";
  const apply = () => {
    const nextMode = mode();
    shell.dataset.collaborationMode = nextMode;
    shell.style.setProperty("--collaboration-panel-w", `${width}px`);
    shell.classList.toggle("collaboration-panel-open", open);
    panel.hidden = !open;
    panel.setAttribute("role", nextMode === "overlay" ? "dialog" : "complementary");
    panel.setAttribute("aria-modal", nextMode === "overlay" && open ? "true" : "false");
    toggle.setAttribute("aria-expanded", String(open));
    if (scrim) scrim.hidden = !open || nextMode !== "overlay";
    if (resizeHandle) resizeHandle.hidden = !open || nextMode !== "docked";
  };
  const openPanel = () => { open = true; apply(); requestAnimationFrame(() => panel.querySelector("button, [tabindex='-1']")?.focus?.()); };
  const closePanel = () => { if (!open) return; open = false; apply(); toggle.focus?.(); };
  const setConversationOpen = (value) => {
    panel.classList.toggle("is-conversation-open", Boolean(value));
    if (home) home.hidden = Boolean(value);
    if (conversation) conversation.hidden = !value;
    if (value) requestAnimationFrame(() => backButton?.focus?.());
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
