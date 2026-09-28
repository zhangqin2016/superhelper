/**
 * Line icons for icon-only buttons, and the button that wears one: the label
 * is its accessible name and the hover/focus tooltip (`data-tip`, styled in
 * ui-primitives.css), never visible text beside the glyph.
 */

const svg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg>`;

export const ICONS = Object.freeze({
  openInPane: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect><path d="M14.5 4.5v15"></path>'),
  openExternal: svg('<path d="M14 4.5h5.5V10"></path><path d="m19.5 4.5-8 8"></path><path d="M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18V7a1.5 1.5 0 0 1 1.5-1.5H10"></path>'),
  reveal: svg('<path d="M3 6.75A2.75 2.75 0 0 1 5.75 4h4.47c.73 0 1.43.29 1.94.8l1.04 1.04c.23.23.54.36.86.36h4.19A2.75 2.75 0 0 1 21 8.95v8.3A2.75 2.75 0 0 1 18.25 20H5.75A2.75 2.75 0 0 1 3 17.25V6.75Z"></path><path d="M14.25 12.25h3.5v3.5"></path><path d="m17.75 12.25-4.5 4.5"></path>'),
  copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"></rect><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"></path>'),
  close: svg('<path d="M6.5 6.5l11 11"></path><path d="M17.5 6.5l-11 11"></path>'),
  zoomIn: svg('<path d="M12 6.5v11"></path><path d="M6.5 12h11"></path>'),
  zoomOut: svg('<path d="M6.5 12h11"></path>'),
  chevronUp: svg('<path d="m7 14.5 5-5 5 5"></path>'),
  chevronDown: svg('<path d="m7 9.5 5 5 5-5"></path>'),
  fitWidth: svg('<path d="M4 12h16"></path><path d="m7 9-3 3 3 3"></path><path d="m17 9 3 3-3 3"></path>'),
});

/**
 * @param {string} className
 * @param {keyof typeof ICONS} icon
 * @param {string} label  accessible name and tooltip
 * @param {{ align?: "start"|"end", onClick?: (event: MouseEvent) => void }} [options]
 */
export function iconButton(className, icon, label, { align = "", onClick = null } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ui-icon-btn ${className}`.trim();
  button.innerHTML = ICONS[icon];
  button.setAttribute("aria-label", label);
  button.dataset.tip = label;
  if (align) button.dataset.tipAlign = align;
  if (onClick) button.addEventListener("click", onClick);
  return button;
}
