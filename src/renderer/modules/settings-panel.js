/**
 * Settings panel — model presets and app maintenance (opened from left sidebar).
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { refreshModelSelect } from "./model-settings.js";
import { refreshPermissionSelect } from "./permission-settings.js";
import { refreshSearchSettings } from "./search-settings.js";
import { refreshSkillsList } from "./skill-settings.js";
import store from "./state.js";

let panelOpen = false;

function setPanelOpen(open) {
  panelOpen = open;
  const panel = $("settingsPanel");
  if (panel) panel.hidden = !open;
  document.body.classList.toggle("settings-open", open);
}

export async function initSettingsPanel() {
  const openBtn = $("settingsBtn");
  const panel = $("settingsPanel");
  const closeBtn = $("settingsCloseBtn");
  const backdrop = $("settingsBackdrop");
  const select = $("modelPresetSelect");

  if (!openBtn || !panel) return;

  openBtn.addEventListener("click", async () => {
    await refreshModelSelect();
    await refreshPermissionSelect();
    await refreshSearchSettings();
    await refreshSkillsList();
    setPanelOpen(true);
  });

  closeBtn?.addEventListener("click", () => setPanelOpen(false));
  backdrop?.addEventListener("click", () => setPanelOpen(false));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panelOpen) setPanelOpen(false);
  });

  select?.addEventListener("change", async () => {
    const presetId = select.value;
    const result = await window.assistantClient.setActiveModel(presetId);
    if (!result.ok) {
      const msg = result.error === "BUSY"
        ? "正在回复中，请稍后再切换模型。"
        : "模型切换失败，请重试。";
      showToast(msg, "error");
      await refreshModelSelect();
      return;
    }
    const active = (result.presets || []).find((p) => p.id === result.activePresetId);
    showToast(`已切换为：${active?.label || "当前模型"}`, "success");
  });

  $("permissionModeSelect")?.addEventListener("change", async () => {
    if ((store.get("runningSessionIds") || []).length > 0) {
      showToast("有对话正在处理中，请稍后再切换权限。", "error");
      await refreshPermissionSelect();
      return;
    }
    const modeId = $("permissionModeSelect").value;
    const result = await window.assistantClient.setActivePermission(modeId);
    if (!result.ok) {
      const msg =
        result.error === "BUSY"
          ? "正在回复中，请稍后再切换权限。"
          : "权限模式切换失败，请重试。";
      showToast(msg, "error");
      await refreshPermissionSelect();
      return;
    }
    const active = (result.modes || []).find((m) => m.id === result.activeModeId);
    showToast(`权限已设为：${active?.label || "当前模式"}`, "success");
  });

  $("settingsClearCache")?.addEventListener("click", async () => {
    const result = await window.assistantClient.clearStagingCache();
    showToast(result?.ok ? "附件缓存已清理" : "清理失败", result?.ok ? "success" : "error");
  });
}
