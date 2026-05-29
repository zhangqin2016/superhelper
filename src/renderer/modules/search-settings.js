/**
 * Web search provider selector (settings panel).
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import store from "./state.js";

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
    option.textContent = provider.label;
    if (provider.description) option.title = provider.description;
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
      showToast("有对话正在处理中，请稍后再切换搜索引擎。", "error");
      await refreshSearchSettings();
      return;
    }
    const providerId = $("searchProviderSelect").value;
    const result = await window.assistantClient.setSearchProvider(providerId);
    if (!result.ok) {
      showToast("搜索引擎切换失败，请重试。", "error");
      await refreshSearchSettings();
      return;
    }
    updateProviderRows(providerId);
    const active = (result.providers || []).find((item) => item.id === result.providerId);
    showToast(`联网搜索已设为：${active?.label || "当前引擎"}`, "success");
  });

  $("searchSaveSearxngUrlBtn")?.addEventListener("click", async () => {
    if (isBusy()) {
      showToast("有对话正在处理中，请稍后再保存。", "error");
      return;
    }
    const url = $("searchSearxngUrl")?.value?.trim() || "";
    const result = await window.assistantClient.setSearxngUrl(url);
    if (!result.ok) {
      showToast("实例地址无效，请使用 http:// 或 https:// 开头的 URL。", "error");
      return;
    }
    showToast(url ? "SearXNG 实例已保存" : "已清除自定义实例，将使用内置公共实例", "success");
    await refreshSearchSettings();
  });
}
