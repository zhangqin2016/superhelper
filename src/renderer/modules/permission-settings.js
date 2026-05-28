/**
 * Permission mode selector (settings panel).
 */

import { $ } from "./dom.js";

export async function refreshPermissionSelect() {
  const select = $("permissionModeSelect");
  if (!select) return;

  const data = await window.assistantClient.listPermissions();
  if (!data?.ok) return;

  select.replaceChildren();
  for (const mode of data.modes || []) {
    const option = document.createElement("option");
    option.value = mode.id;
    option.textContent = mode.label;
    if (mode.description) option.title = mode.description;
    if (mode.id === data.activeModeId) option.selected = true;
    select.appendChild(option);
  }
}

/** Load permission options once at startup. */
export async function initPermissionSettings() {
  await refreshPermissionSelect();
}
