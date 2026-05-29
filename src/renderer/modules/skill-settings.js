/**
 * Skill center (settings panel) — P1 installed + P2 registry URL.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import store from "./state.js";

/** @type {{ available: object[] } | null} */
let lastCatalog = null;

function isBusy() {
  return (store.get("runningSessionIds") || []).length > 0;
}

function sourceLabel(source) {
  if (source === "bundled") return "内置";
  if (source === "remote") return "远程";
  return "本地";
}

function permissionHint(skill) {
  const parts = [];
  if (skill.permissions?.network) parts.push("需联网");
  if (skill.permissions?.filesystem === "read") parts.push("读文件");
  if (skill.permissions?.filesystem === "readwrite") parts.push("读写文件");
  return parts.join(" · ");
}

function errorMessage(error, detail) {
  const map = {
    BUSY: "有对话正在处理中，请稍后再试。",
    NETWORK: detail || "无法连接技能目录，请检查网络或 URL。",
    INVALID_URL: "URL 格式无效，请使用 http:// 或 https:// 地址。",
    CHECKSUM_MISMATCH: "技能包校验失败，未安装。",
    INVALID_MANIFEST: detail || "技能包不符合规范。",
    NOT_FOUND: detail || "未找到该技能。",
    BUNDLED_PROTECTED: "内置技能不能通过远程覆盖。",
  };
  return map[error] || detail || "操作失败，请重试。";
}

function renderInstalledRow(skill) {
  const row = document.createElement("div");
  row.className = "skills-row";
  row.dataset.skillId = skill.id;

  const main = document.createElement("div");
  main.className = "skills-row-main";

  const titleLine = document.createElement("div");
  titleLine.className = "skills-row-title";

  const name = document.createElement("span");
  name.className = "skills-row-name";
  name.textContent = skill.name;

  const badge = document.createElement("span");
  badge.className = "skills-row-badge";
  badge.textContent = sourceLabel(skill.source);

  titleLine.append(name, badge);

  const meta = document.createElement("div");
  meta.className = "skills-row-meta";
  const versionText = skill.updateAvailable
    ? `v${skill.version} → v${skill.latestVersion}`
    : `v${skill.version}`;
  meta.textContent = [versionText, permissionHint(skill)].filter(Boolean).join(" · ");

  const desc = document.createElement("p");
  desc.className = "skills-row-desc";
  desc.textContent = skill.description || "";

  main.append(titleLine, meta, desc);

  const actions = document.createElement("div");
  actions.className = "skills-row-actions";

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "skills-toggle";
  toggle.checked = skill.enabled;
  toggle.setAttribute("aria-label", `${skill.enabled ? "禁用" : "启用"}${skill.name}`);

  toggle.addEventListener("change", async () => {
    const nextEnabled = toggle.checked;
    if (isBusy()) {
      toggle.checked = !nextEnabled;
      showToast("有对话正在处理中，请稍后再改技能。", "error");
      return;
    }
    const result = await window.assistantClient.setSkillEnabled(skill.id, nextEnabled);
    if (!result.ok) {
      toggle.checked = !nextEnabled;
      showToast(errorMessage(result.error), "error");
      return;
    }
    showToast(nextEnabled ? `已启用：${skill.name}` : `已禁用：${skill.name}`, "success");
  });

  actions.append(toggle);

  if (skill.updateAvailable) {
    const updateBtn = document.createElement("button");
    updateBtn.type = "button";
    updateBtn.className = "skills-action-btn skills-action-btn--primary";
    updateBtn.textContent = "更新";
    updateBtn.addEventListener("click", async () => {
      if (isBusy()) {
        showToast("有对话正在处理中，请稍后再操作。", "error");
        return;
      }
      updateBtn.disabled = true;
      const result = await window.assistantClient.updateSkill(skill.id);
      updateBtn.disabled = false;
      if (!result.ok) {
        showToast(errorMessage(result.error, result.detail), "error");
        return;
      }
      showToast(`已更新：${skill.name}`, "success");
      await refreshSkillsList();
    });
    actions.append(updateBtn);
  }

  if (skill.canRestore) {
    const restoreBtn = document.createElement("button");
    restoreBtn.type = "button";
    restoreBtn.className = "skills-restore-btn";
    restoreBtn.textContent = "恢复出厂";
    restoreBtn.addEventListener("click", async () => {
      if (isBusy()) {
        showToast("有对话正在处理中，请稍后再操作。", "error");
        return;
      }
      const result = await window.assistantClient.restoreBundledSkill(skill.id);
      if (!result.ok) {
        showToast(errorMessage(result.error), "error");
        return;
      }
      showToast(`已恢复出厂：${skill.name}`, "success");
      await refreshSkillsList();
    });
    actions.append(restoreBtn);
  }

  if (skill.canUninstall) {
    const uninstallBtn = document.createElement("button");
    uninstallBtn.type = "button";
    uninstallBtn.className = "skills-restore-btn";
    uninstallBtn.textContent = "卸载";
    uninstallBtn.addEventListener("click", async () => {
      if (isBusy()) {
        showToast("有对话正在处理中，请稍后再操作。", "error");
        return;
      }
      const result = await window.assistantClient.uninstallSkill(skill.id);
      if (!result.ok) {
        showToast(errorMessage(result.error), "error");
        return;
      }
      showToast(`已卸载：${skill.name}`, "success");
      await refreshSkillsList();
    });
    actions.append(uninstallBtn);
  }

  row.append(main, actions);
  return row;
}

function renderAvailableRow(skill) {
  const row = document.createElement("div");
  row.className = "skills-row skills-row--available";
  row.dataset.skillId = skill.id;

  const main = document.createElement("div");
  main.className = "skills-row-main";

  const titleLine = document.createElement("div");
  titleLine.className = "skills-row-title";

  const name = document.createElement("span");
  name.className = "skills-row-name";
  name.textContent = skill.name;

  const badge = document.createElement("span");
  badge.className = "skills-row-badge";
  badge.textContent = "目录";

  titleLine.append(name, badge);

  const meta = document.createElement("div");
  meta.className = "skills-row-meta";
  meta.textContent = `v${skill.latestVersion}`;

  const desc = document.createElement("p");
  desc.className = "skills-row-desc";
  desc.textContent = skill.description || skill.changelog || "";

  main.append(titleLine, meta, desc);

  const actions = document.createElement("div");
  actions.className = "skills-row-actions";

  const installBtn = document.createElement("button");
  installBtn.type = "button";
  installBtn.className = "skills-action-btn skills-action-btn--primary";
  installBtn.textContent = "安装";
  installBtn.addEventListener("click", async () => {
    if (isBusy()) {
      showToast("有对话正在处理中，请稍后再操作。", "error");
      return;
    }
    installBtn.disabled = true;
    const result = await window.assistantClient.installSkill(skill.id);
    installBtn.disabled = false;
    if (!result.ok) {
      showToast(errorMessage(result.error, result.detail), "error");
      return;
    }
    showToast(`已安装：${skill.name}`, "success");
    await refreshSkillsList();
    if (lastCatalog) {
      lastCatalog.available = (lastCatalog.available || []).filter((s) => s.id !== skill.id);
      renderAvailableList(lastCatalog.available);
    }
  });

  actions.append(installBtn);
  row.append(main, actions);
  return row;
}

function renderAvailableList(available) {
  const title = $("skillsAvailableTitle");
  const list = $("skillsAvailableList");
  if (!list || !title) return;

  const items = available || [];
  title.hidden = items.length === 0;
  list.replaceChildren();
  for (const skill of items) {
    list.append(renderAvailableRow(skill));
  }
}

function updateRegistryHint(catalog) {
  const hint = $("skillsRegistryHint");
  if (!hint) return;

  if (!catalog?.registryUrl) {
    hint.textContent = "填写符合协议的 registry.json 地址，保存后点击「检查更新」。";
    return;
  }

  const parts = [];
  if (catalog.publisher) parts.push(catalog.publisher);
  if (catalog.fetchedAt) {
    parts.push(`上次检查：${new Date(catalog.fetchedAt).toLocaleString()}`);
  }
  if (catalog.updatesCount > 0) {
    parts.push(`${catalog.updatesCount} 个可更新`);
  }
  hint.textContent = parts.join(" · ") || "已配置技能目录";
}

export async function refreshSkillsList() {
  const list = $("skillsList");
  if (!list) return;

  const data = await window.assistantClient.listSkills();
  if (!data?.ok) return;

  list.replaceChildren();
  for (const skill of data.skills || []) {
    list.append(renderInstalledRow(skill));
  }

  if (lastCatalog?.available) {
    renderAvailableList(lastCatalog.available);
  }
}

async function loadRegistryUrl() {
  const input = $("skillsRegistryUrl");
  if (!input) return;
  const data = await window.assistantClient.getRegistryUrl();
  if (data?.ok) {
    input.value = data.registryUrl || "";
  }
}

export async function initSkillSettings() {
  await loadRegistryUrl();

  $("skillsSaveRegistryBtn")?.addEventListener("click", async () => {
    const url = $("skillsRegistryUrl")?.value?.trim() || "";
    const result = await window.assistantClient.setRegistryUrl(url);
    if (!result.ok) {
      showToast(errorMessage(result.error), "error");
      return;
    }
    showToast(url ? "技能目录 URL 已保存" : "已清除技能目录 URL", "success");
    lastCatalog = null;
    renderAvailableList([]);
    updateRegistryHint({ registryUrl: url });
  });

  $("skillsCheckUpdatesBtn")?.addEventListener("click", async () => {
    if (isBusy()) {
      showToast("有对话正在处理中，请稍后再检查。", "error");
      return;
    }
    const btn = $("skillsCheckUpdatesBtn");
    if (btn) btn.disabled = true;
    const result = await window.assistantClient.checkSkillUpdates();
    if (btn) btn.disabled = false;

    if (!result.ok) {
      showToast(errorMessage(result.error, result.detail), "error");
      return;
    }

    lastCatalog = result;
    updateRegistryHint(result);

    const list = $("skillsList");
    if (list) {
      list.replaceChildren();
      for (const skill of result.installed || []) {
        list.append(renderInstalledRow(skill));
      }
    }
    renderAvailableList(result.available || []);

    if (!result.registryUrl) {
      showToast("请先配置并保存技能目录 URL", "error");
      return;
    }
    if ((result.available || []).length === 0 && (result.updatesCount || 0) === 0) {
      showToast("已是最新版本", "success");
    } else {
      const parts = [];
      if (result.updatesCount) parts.push(`${result.updatesCount} 个可更新`);
      if (result.available?.length) parts.push(`${result.available.length} 个可安装`);
      showToast(parts.join("，"), "success");
    }
  });

  $("skillsRefreshBtn")?.addEventListener("click", async () => {
    if (isBusy()) {
      showToast("有对话正在处理中，请稍后再刷新。", "error");
      return;
    }
    const result = await window.assistantClient.refreshSkills();
    if (!result.ok) {
      showToast(errorMessage(result.error), "error");
      return;
    }
    showToast("技能配置已刷新", "success");
    await refreshSkillsList();
  });

  updateRegistryHint({ registryUrl: $("skillsRegistryUrl")?.value });
  await refreshSkillsList();
}
