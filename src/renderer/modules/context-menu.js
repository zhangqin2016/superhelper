/**
 * A small right-click context menu, the shape WeChat uses for a conversation
 * row or a message. One menu exists at a time; opening another replaces it.
 *
 * `openContextMenu({ x, y, items })` where each item is
 *   { label, onSelect, danger?, disabled? }
 * or the string "separator". The menu positions itself inside the viewport,
 * closes on outside click, Escape, scroll, resize, or blur, and supports
 * arrow-key navigation.
 */
let openMenu = null;

function closeOpenMenu() {
  if (!openMenu) return;
  const { node, cleanup, returnFocusTo } = openMenu;
  openMenu = null;
  cleanup();
  node.remove();
  // Focus goes back where it came from: a menu that swallows focus leaves
  // keyboard users stranded at the top of the document.
  if (returnFocusTo && document.contains(returnFocusTo)) returnFocusTo.focus?.({ preventScroll: true });
}

export function openContextMenu({ x, y, items = [] } = {}) {
  const returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closeOpenMenu();
  const actionable = items.filter((item) => item === "separator" || (item && item.label));
  if (!actionable.some((item) => item !== "separator")) return;

  const menu = document.createElement("div");
  menu.className = "app-context-menu";
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;
  const buttons = [];
  for (const item of actionable) {
    if (item === "separator") {
      const rule = document.createElement("div");
      rule.className = "app-context-menu-separator";
      rule.setAttribute("role", "separator");
      menu.append(rule);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "app-context-menu-item" + (item.danger ? " is-danger" : "");
    button.setAttribute("role", "menuitem");
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    if (!item.disabled) {
      button.addEventListener("click", () => {
        closeOpenMenu();
        try { item.onSelect?.(); } catch { /* an action's own failure must not wedge the menu */ }
      });
    }
    buttons.push(button);
    menu.append(button);
  }
  document.body.append(menu);

  // Position within the viewport: flip left/up when the menu would overflow.
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const left = x + rect.width > vw - 8 ? Math.max(8, x - rect.width) : x;
  const top = y + rect.height > vh - 8 ? Math.max(8, y - rect.height) : y;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const onPointerDown = (event) => { if (!menu.contains(event.target)) closeOpenMenu(); };
  const onKey = (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeOpenMenu(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const enabled = buttons.filter((b) => !b.disabled);
    if (!enabled.length) return;
    const current = enabled.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? (current + 1) % enabled.length : (current - 1 + enabled.length) % enabled.length;
    enabled[next].focus();
  };
  const cleanup = () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", closeOpenMenu, true);
    window.removeEventListener("blur", closeOpenMenu, true);
    document.removeEventListener("scroll", closeOpenMenu, true);
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", closeOpenMenu, true);
  window.addEventListener("blur", closeOpenMenu, true);
  document.addEventListener("scroll", closeOpenMenu, true);

  openMenu = { node: menu, cleanup, returnFocusTo };
  requestAnimationFrame(() => buttons.find((b) => !b.disabled)?.focus?.());
}

export function closeContextMenu() { closeOpenMenu(); }
