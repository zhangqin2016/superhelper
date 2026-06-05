/**
 * Per-session skill picker in the composer (tree + popover).
 */

import { $ } from "./dom.js";
import store from "./state.js";
import { showToast } from "./toast.js";
import { canSend } from "./session-runtime-store.js";
import { t, tSkillName, tSkillDesc } from "../i18n/index.js";
import {
  renderSkillTree,
  syncAllSkillTreeGroupSelects,
  syncSkillTreeGroupSelect,
} from "./skills-tree-ui.js";

function isBusy() {
  const sid = store.get("activeSessionId");
  return sid ? !canSend(sid) : false;
}

/** @type {{ customized: boolean, effectiveIds: string[], skills: object[] } | null} */
let lastPayload = null;

function activeSessionId() {
  return store.get("activeSessionId");
}

function isPopoverOpen() {
  const popover = $("sessionSkillsPopover");
  return Boolean(popover && !popover.hidden);
}

function enabledSkillCount() {
  return (lastPayload?.skills || []).filter((s) => s.sessionEnabled).length;
}

function countCheckedInList(listEl) {
  let count = 0;
  listEl?.querySelectorAll(".skills-tree-row-input").forEach((input) => {
    if (input.checked) count += 1;
  });
  return count;
}

function updateSkillButtonBadge(countOverride) {
  const btn = $("sessionSkillsBtn");
  const label = btn?.querySelector(".composer-skill-btn-label");
  if (!label) return;
  const count =
    typeof countOverride === "number" ? countOverride : enabledSkillCount();
  const base = t("composer.skills");
  label.textContent = count > 0 ? `${base} (${count})` : base;
}

function applyRowSelectionState(row, checked) {
  row.classList.toggle("skills-tree-row--selected", checked);
  row.setAttribute("aria-checked", checked ? "true" : "false");
  const mark = row.querySelector(".skills-tree-row-mark");
  if (mark) mark.setAttribute("data-checked", checked ? "true" : "false");
}

function updateResetButton() {
  const resetBtn = $("sessionSkillsResetBtn");
  if (!resetBtn) return;
  resetBtn.hidden = !lastPayload?.customized;
  resetBtn.disabled = isBusy();
}

function updateBulkActionButtons(list) {
  const busy = isBusy();
  $("sessionSkillsSelectAllBtn")?.toggleAttribute("disabled", busy);
  $("sessionSkillsDeselectAllBtn")?.toggleAttribute("disabled", busy);
  list?.querySelectorAll(".skills-tree-group-select").forEach((select) => {
    select.disabled = busy;
  });
}

function collectEnabledIds(listEl) {
  const enabledIds = [];
  listEl?.querySelectorAll(".skills-tree-row").forEach((row) => {
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb?.checked && row.dataset.skillId) {
      enabledIds.push(row.dataset.skillId);
    }
  });
  return enabledIds;
}

function closePopover() {
  const popover = $("sessionSkillsPopover");
  if (!popover || popover.hidden) return;
  popover.hidden = true;
  $("sessionSkillsBtn")?.classList.remove("is-open");
  hideSkillTags();
  updateSkillButtonBadge();
}

function hideSkillTags() {
  const wrap = $("sessionSkillTagsWrap");
  if (wrap) wrap.hidden = true;
}

function openPopover() {
  const popover = $("sessionSkillsPopover");
  const btn = $("sessionSkillsBtn");
  const composer = $("composer");
  if (!popover || !btn || !composer) return;
  popover.hidden = false;
  btn.classList.add("is-open");
  const btnRect = btn.getBoundingClientRect();
  const composerRect = composer.getBoundingClientRect();
  popover.style.left = "8px";
  popover.style.width = `${Math.max(0, composerRect.width - 16)}px`;
  popover.style.bottom = `${composerRect.bottom - btnRect.top + 8}px`;
}

function syncPopoverFromPayload() {
  const list = $("sessionSkillsPopoverList");
  if (!list || !lastPayload) return;

  const skillMap = new Map(lastPayload.skills.map((s) => [s.id, s]));
  list.querySelectorAll(".skills-tree-row").forEach((row) => {
    const skill = skillMap.get(row.dataset.skillId);
    if (!skill) return;
    const input = row.querySelector('input[type="checkbox"]');
    const checked = Boolean(skill.sessionEnabled);
    if (input) {
      input.checked = checked;
      input.disabled = isBusy();
    }
    applyRowSelectionState(row, checked);
    row.classList.toggle("skills-tree-row--global-off", !skill.globallyEnabled);
    row.classList.toggle("skills-tree-row--busy", isBusy());
  });

  list.querySelectorAll(".skills-tree-group").forEach((groupEl) => {
    const rows = groupEl.querySelectorAll(".skills-tree-row");
    let enabledCount = 0;
    rows.forEach((row) => {
      const skill = skillMap.get(row.dataset.skillId);
      if (skill?.sessionEnabled) enabledCount += 1;
    });
    const countEl = groupEl.querySelector(".skills-tree-group-count");
    if (countEl) {
      countEl.textContent = t("composer.sessionSkillsGroupCount", {
        enabled: enabledCount,
        total: rows.length,
      });
    }
    if (enabledCount > 0) {
      groupEl.dataset.expanded = "true";
      groupEl.classList.add("skills-tree-group--expanded");
      groupEl.setAttribute("aria-expanded", "true");
    }
  });

  syncAllSkillTreeGroupSelects(list);
  updateBulkActionButtons(list);
  updateResetButton();
  updateSkillButtonBadge();
}

function updateGroupCount(groupEl, enabledCount, total) {
  const countEl = groupEl.querySelector(".skills-tree-group-count");
  if (countEl) {
    countEl.textContent = t("composer.sessionSkillsGroupCount", {
      enabled: enabledCount,
      total,
    });
  }
}

async function setRowsChecked(rows, checked, list) {
  if (isBusy()) {
    showToast(t("toast.sessionSkillsBusy"), "error");
    return false;
  }
  const scrollTop = list.scrollTop;
  for (const row of rows) {
    const input = row.querySelector('input[type="checkbox"]');
    if (!input || input.disabled) continue;
    input.checked = checked;
    applyRowSelectionState(row, checked);
  }
  updateSkillButtonBadge(countCheckedInList(list));
  const result = await enqueuePersist(collectEnabledIds(list));
  if (!result) {
    syncPopoverFromPayload();
    return false;
  }
  list.querySelectorAll(".skills-tree-group").forEach((groupEl) => {
    syncSkillTreeGroupSelect(groupEl);
  });
  list.scrollTop = scrollTop;
  return true;
}

async function toggleSkillGroup(group, groupEl, checked, list) {
  const rows = [...groupEl.querySelectorAll(".skills-tree-row")];
  await setRowsChecked(rows, checked, list);
}

async function setAllSkillsChecked(list, checked) {
  const rows = [...list.querySelectorAll(".skills-tree-row")];
  await setRowsChecked(rows, checked, list);
}

let persistQueue = Promise.resolve();

function enqueuePersist(enabledSkillIds) {
  const next = persistQueue.then(() => persistSelection(enabledSkillIds));
  persistQueue = next.catch(() => {});
  return next;
}

async function persistSelection(enabledSkillIds) {
  const sessionId = activeSessionId();
  if (!sessionId) return null;
  if (isBusy()) {
    showToast(t("toast.sessionSkillsBusy"), "error");
    return null;
  }
  const result = await window.assistantClient.setSessionSkills(sessionId, enabledSkillIds);
  if (!result?.ok) {
    const msg =
      result?.error === "BUSY"
        ? t("toast.sessionSkillsBusy")
        : t("toast.sessionSkillsSaveFailed");
    showToast(msg, "error");
    return null;
  }
  lastPayload = {
    customized: result.customized,
    effectiveIds: result.effectiveIds || [],
    skills: result.skills || [],
  };
  store.set("sessionSkills", lastPayload);

  if (isPopoverOpen()) {
    syncPopoverFromPayload();
  } else {
    hideSkillTags();
    updateSkillButtonBadge();
  }
  return result;
}

async function toggleSkillRow(row, list) {
  if (isBusy()) {
    showToast(t("toast.sessionSkillsBusy"), "error");
    return;
  }

  const input = row.querySelector('input[type="checkbox"]');
  if (!input || input.disabled) return;

  const scrollTop = list.scrollTop;
  const nextChecked = !input.checked;
  input.checked = nextChecked;
  applyRowSelectionState(row, nextChecked);
  row.classList.add("skills-tree-row--pulse");
  window.setTimeout(() => row.classList.remove("skills-tree-row--pulse"), 220);
  updateSkillButtonBadge(countCheckedInList(list));

  const enabledIds = collectEnabledIds(list);
  const result = await enqueuePersist(enabledIds);
  if (!result) {
    input.checked = !nextChecked;
    applyRowSelectionState(row, input.checked);
    updateSkillButtonBadge(countCheckedInList(list));
  } else {
    const groupEl = row.closest(".skills-tree-group");
    if (groupEl) {
      syncSkillTreeGroupSelect(groupEl);
      const rows = groupEl.querySelectorAll(".skills-tree-row");
      let enabledCount = 0;
      rows.forEach((r) => {
        if (r.querySelector('input[type="checkbox"]')?.checked) enabledCount += 1;
      });
      updateGroupCount(groupEl, enabledCount, rows.length);
    }
  }
  list.scrollTop = scrollTop;
}

function buildSkillTreeRow(skill, list) {
  const busy = isBusy();
  const row = document.createElement("div");
  row.className = "skills-tree-row skills-tree-row--pickable";
  row.dataset.skillId = skill.id;
  row.setAttribute("role", "treeitem");
  row.tabIndex = busy ? -1 : 0;
  if (skill.sessionEnabled) row.classList.add("skills-tree-row--selected");
  if (!skill.globallyEnabled) row.classList.add("skills-tree-row--global-off");
  if (busy) row.classList.add("skills-tree-row--busy");
  applyRowSelectionState(row, Boolean(skill.sessionEnabled));

  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "skills-tree-row-input";
  input.checked = Boolean(skill.sessionEnabled);
  input.disabled = busy;
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");

  const mark = document.createElement("span");
  mark.className = "skills-tree-row-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.setAttribute("data-checked", skill.sessionEnabled ? "true" : "false");

  row.addEventListener("click", (event) => {
    event.preventDefault();
    void toggleSkillRow(row, list);
  });
  row.addEventListener("keydown", (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    void toggleSkillRow(row, list);
  });

  const name = document.createElement("span");
  name.className = "skills-tree-row-name";
  name.textContent = tSkillName(skill);

  const descText = tSkillDesc(skill);
  if (descText) row.title = descText;

  row.append(input, mark, name);

  if (!skill.globallyEnabled) {
    const badge = document.createElement("span");
    badge.className = "skills-tree-row-badge";
    badge.textContent = t("skills.globalOff");
    row.append(badge);
  }

  return row;
}

function renderPopoverList() {
  const list = $("sessionSkillsPopoverList");
  if (!list) return;

  const skills = lastPayload?.skills || [];
  renderSkillTree(list, skills, {
    enabledKey: "sessionEnabled",
    countLabel: (group) =>
      t("composer.sessionSkillsGroupCount", {
        enabled: group.enabledCount,
        total: group.skills.length,
      }),
    renderRow: (skill) => buildSkillTreeRow(skill, list),
    groupSelect: {
      disabled: isBusy(),
      onToggle: (group, groupEl, checked) => {
        void toggleSkillGroup(group, groupEl, checked, list);
      },
    },
  });

  syncAllSkillTreeGroupSelects(list);
  updateBulkActionButtons(list);
  updateResetButton();
  updateSkillButtonBadge();
}

export async function refreshSessionSkillsUi() {
  const sessionId = activeSessionId();
  const btn = $("sessionSkillsBtn");
  if (!sessionId) {
    lastPayload = null;
    store.set("sessionSkills", null);
    hideSkillTags();
    if (btn) btn.disabled = true;
    closePopover();
    updateSkillButtonBadge();
    return;
  }

  if (btn) btn.disabled = false;

  try {
    const result = await window.assistantClient.getSessionSkills(sessionId);
    if (!result?.ok) {
      lastPayload = null;
      return;
    }
    lastPayload = {
      customized: result.customized,
      effectiveIds: result.effectiveIds || [],
      skills: result.skills || [],
    };
    store.set("sessionSkills", lastPayload);
    if (isPopoverOpen()) {
      if (!listHasCurrentSkills($("sessionSkillsPopoverList"), lastPayload.skills)) {
        renderPopoverList();
      } else {
        syncPopoverFromPayload();
      }
    } else {
      hideSkillTags();
      updateSkillButtonBadge();
    }
  } catch {
    lastPayload = null;
  }
}

function listHasCurrentSkills(listEl, skills) {
  if (!listEl) return false;
  const ids = new Set((skills || []).map((s) => s.id));
  const rowIds = [...listEl.querySelectorAll(".skills-tree-row")].map(
    (row) => row.dataset.skillId,
  );
  if (rowIds.length !== ids.size) return false;
  return rowIds.every((id) => ids.has(id));
}

export function initSessionSkills() {
  $("sessionSkillsBtn")?.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!activeSessionId()) {
      showToast(t("toast.selectSession"), "warning");
      return;
    }
    const popover = $("sessionSkillsPopover");
    if (!popover) return;
    if (popover.hidden) {
      await refreshSessionSkillsUi();
      renderPopoverList();
      openPopover();
    } else {
      closePopover();
    }
  });

  $("sessionSkillsPopoverClose")?.addEventListener("click", () => closePopover());

  $("sessionSkillsResetBtn")?.addEventListener("click", async () => {
    const list = $("sessionSkillsPopoverList");
    const scrollTop = list?.scrollTop ?? 0;
    const result = await enqueuePersist(null);
    if (result?.ok) {
      showToast(t("toast.sessionSkillsReset"), "success");
      syncPopoverFromPayload();
      if (list) list.scrollTop = scrollTop;
    }
  });

  $("sessionSkillsSelectAllBtn")?.addEventListener("click", () => {
    const list = $("sessionSkillsPopoverList");
    if (list) void setAllSkillsChecked(list, true);
  });

  $("sessionSkillsDeselectAllBtn")?.addEventListener("click", () => {
    const list = $("sessionSkillsPopoverList");
    if (list) void setAllSkillsChecked(list, false);
  });

  document.addEventListener("click", (e) => {
    const popover = $("sessionSkillsPopover");
    const btn = $("sessionSkillsBtn");
    if (!popover || popover.hidden) return;
    if (popover.contains(e.target) || btn?.contains(e.target)) return;
    closePopover();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePopover();
  });
}
