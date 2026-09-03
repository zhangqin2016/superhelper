/**
 * Permission mode selector (settings panel).
 */

import { $ } from "./dom.js";
import { t, tPermission, tPermissionDesc } from "../i18n/index.js";
import { activeSession } from "./session-chrome.js";

let sessionPermissionMenuWired = false;

function addModeOptions(select, modes, selectedModeId) {
  for (const mode of modes || []) {
    const option = document.createElement("option");
    option.value = mode.id;
    option.textContent = tPermission(mode);
    const desc = tPermissionDesc(mode);
    if (desc) option.title = desc;
    if (mode.id === selectedModeId) option.selected = true;
    select.appendChild(option);
  }
}

function sessionPermissionElements() {
  return {
    select: $("sessionPermissionModeSelect"),
    button: $("sessionPermissionModeButton"),
    menu: $("sessionPermissionModeMenu"),
    wrap: document.querySelector(".permission-mode-wrap"),
  };
}

function selectedSessionPermissionLabel(select) {
  return select?.selectedOptions?.[0]?.textContent || select?.options?.[0]?.textContent || "";
}

function closeSessionPermissionMenu() {
  const { button, menu, wrap } = sessionPermissionElements();
  if (menu) menu.hidden = true;
  if (button) button.setAttribute("aria-expanded", "false");
  wrap?.classList.remove("is-open");
}

function focusPermissionOption(menu, delta) {
  const options = Array.from(menu?.querySelectorAll(".permission-mode-option") || []);
  if (!options.length) return;
  const current = options.indexOf(document.activeElement);
  const next = current < 0 ? 0 : (current + delta + options.length) % options.length;
  options[next]?.focus();
}

function toggleSessionPermissionMenu(forceOpen = null) {
  const { select, button, menu, wrap } = sessionPermissionElements();
  if (!select || !button || !menu || select.disabled) return;
  syncSessionPermissionMenu();
  const open = forceOpen ?? menu.hidden;
  menu.hidden = !open;
  button.setAttribute("aria-expanded", open ? "true" : "false");
  wrap?.classList.toggle("is-open", open);
  if (open) {
    const selected = menu.querySelector('.permission-mode-option[aria-selected="true"]');
    requestAnimationFrame(() => (selected || menu.querySelector(".permission-mode-option"))?.focus());
  }
}

function chooseSessionPermissionMode(value) {
  const { select } = sessionPermissionElements();
  if (!select || select.disabled) return;
  select.value = value || "inherit";
  closeSessionPermissionMenu();
  syncSessionPermissionMenu();
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function syncSessionPermissionMenu() {
  const { select, button, menu } = sessionPermissionElements();
  if (!select || !button || !menu) return;
  const label = selectedSessionPermissionLabel(select) || t("settings.sessionPermissionSelect");
  // The trigger shows the effective mode ("全自主"); the full "inherits the
  // global default (…)" wording stays in the menu and the tooltip, so the
  // toolbar does not carry a sentence.
  button.textContent = select.selectedOptions?.[0]?.dataset?.shortLabel || label;
  button.title = select.title || label;
  button.disabled = select.disabled;
  button.setAttribute("aria-disabled", select.disabled ? "true" : "false");
  menu.replaceChildren();

  for (const option of Array.from(select.options || [])) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "permission-mode-option";
    item.setAttribute("role", "option");
    item.dataset.value = option.value;
    item.textContent = option.textContent || option.value;
    item.title = option.title || option.textContent || "";
    item.tabIndex = -1;
    item.setAttribute("aria-selected", option.selected ? "true" : "false");
    item.addEventListener("click", () => chooseSessionPermissionMode(option.value));
    menu.appendChild(item);
  }

  if (select.disabled) closeSessionPermissionMenu();
}

function wireSessionPermissionMenu() {
  if (sessionPermissionMenuWired) return;
  const { select, button, menu, wrap } = sessionPermissionElements();
  if (!select || !button || !menu) return;
  sessionPermissionMenuWired = true;

  button.addEventListener("click", (event) => {
    event.preventDefault();
    toggleSessionPermissionMenu();
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleSessionPermissionMenu(true);
    }
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSessionPermissionMenu();
      button.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      focusPermissionOption(menu, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusPermissionOption(menu, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      menu.querySelector(".permission-mode-option")?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      const options = menu.querySelectorAll(".permission-mode-option");
      options[options.length - 1]?.focus();
    }
  });
  select.addEventListener("change", syncSessionPermissionMenu);
  document.addEventListener("pointerdown", (event) => {
    if (!wrap?.contains(event.target)) closeSessionPermissionMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSessionPermissionMenu();
  });
}

export async function refreshGlobalPermissionSelect() {
  const select = $("permissionModeSelect");
  if (!select) return;

  const data = await window.assistantClient.listPermissions();
  if (!data?.ok) return;

  select.replaceChildren();
  addModeOptions(select, data.modes || [], data.activeModeId);
}

export async function refreshSessionPermissionSelect() {
  wireSessionPermissionMenu();
  const select = $("sessionPermissionModeSelect");
  if (!select) return;

  const session = activeSession();
  select.disabled = !session?.id;
  select.replaceChildren();

  if (!session?.id) {
    const option = document.createElement("option");
    option.value = "inherit";
    option.textContent = t("settings.sessionPermissionNoSession");
    select.appendChild(option);
    syncSessionPermissionMenu();
    return;
  }

  let data = null;
  try { data = await window.assistantClient.getSessionPermission(session.id); } catch { data = null; }
  if (!data?.ok) {
    // The session exists; only the modes could not be read. Say that, rather
    // than leaving whatever option was rendered before (possibly "select a
    // session first") in place.
    const option = document.createElement("option");
    option.value = "inherit";
    option.textContent = t("settings.sessionPermissionTitle");
    select.appendChild(option);
    select.disabled = true;
    syncSessionPermissionMenu();
    return;
  }

  const inherit = document.createElement("option");
  inherit.value = "inherit";
  const global = (data.modes || []).find((mode) => mode.id === data.globalModeId);
  const globalLabel = tPermission(global) || data.globalModeId;
  inherit.textContent = t("settings.sessionPermissionInheritOption", { label: globalLabel });
  inherit.dataset.shortLabel = globalLabel;
  inherit.selected = data.inherited;
  select.appendChild(inherit);
  addModeOptions(select, data.modes || [], data.modeId);

  const effective = (data.modes || []).find((mode) => mode.id === data.effectiveModeId);
  select.title = data.inherited
    ? t("settings.sessionPermissionInheritedHint", { label: tPermission(effective) || data.effectiveModeId })
    : t("settings.sessionPermissionOverrideHint", { label: tPermission(effective) || data.effectiveModeId });
  syncSessionPermissionMenu();
}

export async function refreshPermissionSelect() {
  await refreshGlobalPermissionSelect();
  await refreshSessionPermissionSelect();
}

export async function initPermissionSettings() {
  await refreshPermissionSelect();
}
