/**
 * Model preset options — rendered inside the settings panel.
 */

import { $ } from "./dom.js";

export async function refreshModelSelect() {
  const select = $("modelPresetSelect");
  if (!select) return;

  const data = await window.assistantClient.listModels();
  if (!data?.ok) return;

  select.replaceChildren();
  for (const preset of data.presets || []) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.model ? `${preset.label} · ${preset.model}` : preset.label;
    if (preset.description) option.title = preset.description;
    if (preset.id === data.activePresetId) option.selected = true;
    select.appendChild(option);
  }
}
