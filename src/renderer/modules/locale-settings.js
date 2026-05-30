/**
 * Interface language selector (settings panel).
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { getLocale, setLocale, t } from "../i18n/index.js";

export async function refreshLocaleSelect() {
  const select = $("localeSelect");
  if (!select) return;

  const data = await window.assistantClient.getLocale();
  const supported = data?.supported || ["zh-CN", "en", "ar"];
  const active = data?.locale || getLocale();

  select.replaceChildren();
  for (const locale of supported) {
    const option = document.createElement("option");
    option.value = locale;
    option.textContent = t(`settings.language.${locale}`);
    if (locale === active) option.selected = true;
    select.appendChild(option);
  }
}

export function initLocaleSettings() {
  const select = $("localeSelect");
  if (!select) return;

  select.addEventListener("change", async () => {
    const locale = select.value;
    await setLocale(locale);
    await refreshLocaleSelect();
    showToast(t("toast.localeSwitched"), "success");

    const { renderProjectTree } = await import("./project-tree.js");
    const { updateTopbarTitles } = await import("./session-chrome.js");
    const { refreshModelSelect } = await import("./model-settings.js");
    const { refreshPermissionSelect } = await import("./permission-settings.js");
    const { refreshSearchSettings } = await import("./search-settings.js");
    const { refreshSkillsList } = await import("./skill-settings.js");
    const { refreshSessionSkillsUi } = await import("./session-skills.js");
    const { syncComposerForActiveSession } = await import("./message.js");

    updateTopbarTitles();
    renderProjectTree();
    await refreshModelSelect();
    await refreshPermissionSelect();
    await refreshSearchSettings();
    await refreshSkillsList();
    await refreshSessionSkillsUi();
    syncComposerForActiveSession();
  });
}
