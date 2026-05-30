/**
 * Permission mode selector (settings panel).
 */

import { $ } from "./dom.js";
import { tPermission, tPermissionDesc } from "../i18n/index.js";

export async function refreshPermissionSelect() {
  const select = $("permissionModeSelect");
  if (!select) return;

  const data = await window.assistantClient.listPermissions();
  if (!data?.ok) return;

  select.replaceChildren();
  for (const mode of data.modes || []) {
    const option = document.createElement("option");
    option.value = mode.id;
    option.textContent = tPermission(mode);
    const desc = tPermissionDesc(mode);
    if (desc) option.title = desc;
    if (mode.id === data.activeModeId) option.selected = true;
    select.appendChild(option);
  }
}

export async function initPermissionSettings() {
  await refreshPermissionSelect();
}
