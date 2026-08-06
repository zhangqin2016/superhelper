/** Position the conversation character popover against its trigger button. */
export function positionCharacterPopover({ panel, trigger }) {
  if (!panel || panel.hidden || !trigger) return;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const buttonRect = trigger.getBoundingClientRect();
  const width = Math.min(620, Math.max(320, viewportWidth - 24));
  panel.style.position = "fixed";
  panel.style.width = `${width}px`;
  panel.style.insetInlineStart = "8px";
  panel.style.insetInlineEnd = "auto";
  panel.style.bottom = "auto";
  panel.style.top = "12px";
  const panelRect = panel.getBoundingClientRect();
  const gap = 10;
  const below = buttonRect.bottom + gap;
  const above = buttonRect.top - panelRect.height - gap;
  const maxTop = Math.max(12, viewportHeight - panelRect.height - 12);
  const top = above >= 12 || below > maxTop
    ? Math.min(Math.max(12, above), maxTop)
    : Math.min(below, maxTop);
  panel.style.top = `${top}px`;
  if (getComputedStyle(panel).direction === "rtl") {
    panel.style.right = `${Math.max(12, viewportWidth - buttonRect.right)}px`;
    panel.style.left = "auto";
  } else {
    panel.style.left = `${Math.min(Math.max(12, buttonRect.left), viewportWidth - width - 12)}px`;
    panel.style.right = "auto";
  }
}

/** Keep the popover inside the viewport as asynchronous content changes its size. */
export function bindCharacterPopoverPosition({ panel, trigger }) {
  if (!panel || !trigger) return () => {};
  let frame = 0;
  const reposition = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => positionCharacterPopover({ panel, trigger }));
  };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(reposition) : null;
  observer?.observe(panel);
  window.addEventListener("resize", reposition);
  return () => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    window.removeEventListener("resize", reposition);
  };
}
