/**
 * Web search provider selector (settings panel).
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import store from "./state.js";
import { t, tSearchProvider, tSearchProviderDesc } from "../i18n/index.js";

function isBusy() {
  return (store.get("runningSessionIds") || []).length > 0;
}

function updateProviderRows(providerId) {
  const searxRow = $("searchSearxngUrlRow");
  const searxHint = $("searchSearxngHint");
  if (searxRow) searxRow.hidden = providerId !== "searxng";
  if (searxHint) searxHint.hidden = providerId !== "searxng";
}

export async function refreshSearchSettings() {
  const select = $("searchProviderSelect");
  const urlInput = $("searchSearxngUrl");
  if (!select) return;

  const data = await window.assistantClient.listSearchSettings();
  if (!data?.ok) return;

  select.replaceChildren();
  for (const provider of data.providers || []) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = tSearchProvider(provider);
    const desc = tSearchProviderDesc(provider);
    if (desc) option.title = desc;
    if (provider.id === data.providerId) option.selected = true;
    select.appendChild(option);
  }

  if (urlInput) {
    urlInput.value = data.searxngUrl || "";
  }
  updateProviderRows(data.providerId || "iqs");
}

export async function initSearchSettings() {
  await refreshSearchSettings();

  $("searchProviderSelect")?.addEventListener("change", async () => {
    if (isBusy()) {
      showToast(t("toast.searchBusy"), "error");
      await refreshSearchSettings();
      return;
    }
    const providerId = $("searchProviderSelect").value;
    const result = await window.assistantClient.setSearchProvider(providerId);
    if (!result.ok) {
      showToast(t("toast.searchSwitchFailed"), "error");
      await refreshSearchSettings();
      return;
    }
    updateProviderRows(providerId);
    const active = (result.providers || []).find((item) => item.id === result.providerId);
    showToast(t("toast.searchSwitched", { label: tSearchProvider(active) || "" }), "success");
  });

  $("searchSaveSearxngUrlBtn")?.addEventListener("click", async () => {
    if (isBusy()) {
      showToast(t("toast.searchSaveBusy"), "error");
      return;
    }
    const url = $("searchSearxngUrl")?.value?.trim() || "";
    const result = await window.assistantClient.setSearxngUrl(url);
    if (!result.ok) {
      showToast(t("toast.searchUrlInvalid"), "error");
      return;
    }
    showToast(url ? t("toast.searchUrlSaved") : t("toast.searchUrlCleared"), "success");
    await refreshSearchSettings();
  });
}
