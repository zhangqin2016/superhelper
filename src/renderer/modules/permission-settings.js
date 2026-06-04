/**
 * Permission mode selector (settings panel).
 */

import { $ } from "./dom.js";
import { t, tPermission, tPermissionDesc } from "../i18n/index.js";
import { activeSession } from "./session-chrome.js";

function addModeOptions(select, modes, selectedModeId) {
  for (const mode of modes || []) {
    if (mode.id === "dontAsk" && mode.id !== selectedModeId) continue;
    const option = document.createElement("option");
    option.value = mode.id;
    option.textContent = tPermission(mode);
    const desc = tPermissionDesc(mode);
    if (desc) option.title = desc;
    if (mode.id === selectedModeId) option.selected = true;
    select.appendChild(option);
  }
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
    return;
  }

  const data = await window.assistantClient.getSessionPermission(session.id);
  if (!data?.ok) return;

  const inherit = document.createElement("option");
  inherit.value = "inherit";
  const global = (data.modes || []).find((mode) => mode.id === data.globalModeId);
  inherit.textContent = t("settings.sessionPermissionInheritOption", {
    label: tPermission(global) || data.globalModeId,
  });
  inherit.selected = data.inherited;
  select.appendChild(inherit);
  addModeOptions(select, data.modes || [], data.modeId);

  const effective = (data.modes || []).find((mode) => mode.id === data.effectiveModeId);
  select.title = data.inherited
    ? t("settings.sessionPermissionInheritedHint", { label: tPermission(effective) || data.effectiveModeId })
    : t("settings.sessionPermissionOverrideHint", { label: tPermission(effective) || data.effectiveModeId });
}

export async function refreshPermissionSelect() {
  await refreshGlobalPermissionSelect();
  await refreshSessionPermissionSelect();
}

export async function initPermissionSettings() {
  await refreshPermissionSelect();
}
