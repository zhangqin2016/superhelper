/**
 * Per-session skill picker in the composer (tags + popover).
 */

import { $ } from "./dom.js";
import store from "./state.js";
import { showToast } from "./toast.js";
import { isSessionRunning } from "./session-busy.js";
import { t, tSkillName, tSkillDesc } from "../i18n/index.js";

/** @type {{ customized: boolean, effectiveIds: string[], skills: object[] } | null} */
let lastPayload = null;

function activeSessionId() {
  return store.get("activeSessionId");
}

function isBusy() {
  const sid = activeSessionId();
  return sid ? isSessionRunning(sid) : false;
}

function isPopoverOpen() {
  const popover = $("sessionSkillsPopover");
  return Boolean(popover && !popover.hidden);
}

function enabledSkillCount() {
  return (lastPayload?.skills || []).filter((s) => s.sessionEnabled).length;
}

function updateSkillButtonBadge() {
  const btn = $("sessionSkillsBtn");
  const label = btn?.querySelector(".composer-skill-btn-label");
  if (!label) return;
  const count = enabledSkillCount();
  const base = t("composer.skills");
  label.textContent = count > 0 ? `${base} (${count})` : base;
}

function updateResetButton() {
  const resetBtn = $("sessionSkillsResetBtn");
  if (!resetBtn) return;
  resetBtn.hidden = !lastPayload?.customized;
  resetBtn.disabled = isBusy();
}

function collectEnabledIds(listEl) {
  const enabledIds = [];
  listEl?.querySelectorAll(".session-skills-card").forEach((card) => {
    const cb = card.querySelector('input[type="checkbox"]');
    if (cb?.checked && card.dataset.skillId) {
      enabledIds.push(card.dataset.skillId);
    }
  });
  return enabledIds;
}

function closePopover() {
  const popover = $("sessionSkillsPopover");
  if (!popover || popover.hidden) return;
  popover.hidden = true;
  renderTags();
  updateSkillButtonBadge();
}

function openPopover() {
  const popover = $("sessionSkillsPopover");
  const btn = $("sessionSkillsBtn");
  const composer = $("composer");
  if (!popover || !btn || !composer) return;
  popover.hidden = false;
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
  list.querySelectorAll(".session-skills-card").forEach((card) => {
    const skill = skillMap.get(card.dataset.skillId);
    if (!skill) return;
    const input = card.querySelector('input[type="checkbox"]');
    const checked = Boolean(skill.sessionEnabled);
    if (input) {
      input.checked = checked;
      input.disabled = isBusy();
    }
    card.classList.toggle("session-skills-card--selected", checked);
    card.classList.toggle("session-skills-card--global-off", !skill.globallyEnabled);
  });
  updateResetButton();
  updateSkillButtonBadge();
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
    renderTags();
    updateSkillButtonBadge();
  }
  return result;
}

function renderTags() {
  const container = $("sessionSkillTags");
  if (!container) return;
  container.replaceChildren();

  const skills = (lastPayload?.skills || []).filter((s) => s.sessionEnabled);
  if (!skills.length) {
    container.hidden = true;
    updateSkillButtonBadge();
    return;
  }

  container.hidden = false;
  for (const skill of skills) {
    const chip = document.createElement("span");
    chip.className = "session-skill-chip";
    chip.dataset.skillId = skill.id;

    const label = document.createElement("span");
    label.className = "session-skill-chip-label";
    label.textContent = tSkillName(skill);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "session-skill-chip-remove";
    removeBtn.setAttribute("aria-label", t("skills.removeSkill", { name: tSkillName(skill) }));
    removeBtn.textContent = "×";
    removeBtn.disabled = isBusy();
    removeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const enabledIds = (lastPayload?.skills || [])
        .filter((s) => s.sessionEnabled && s.id !== skill.id)
        .map((s) => s.id);
      await persistSelection(enabledIds);
    });

    chip.append(label, removeBtn);
    container.append(chip);
  }
  updateSkillButtonBadge();
}

function buildSkillCard(skill, list) {
  const busy = isBusy();
  const card = document.createElement("label");
  card.className = "session-skills-card";
  card.dataset.skillId = skill.id;
  if (skill.sessionEnabled) card.classList.add("session-skills-card--selected");
  if (!skill.globallyEnabled) card.classList.add("session-skills-card--global-off");

  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "session-skills-card-input";
  input.checked = Boolean(skill.sessionEnabled);
  input.disabled = busy;
  input.addEventListener("change", async () => {
    const scrollTop = list.scrollTop;
    card.classList.toggle("session-skills-card--selected", input.checked);
    const enabledIds = collectEnabledIds(list);
    const result = await persistSelection(enabledIds);
    if (!result) {
      input.checked = !input.checked;
      card.classList.toggle("session-skills-card--selected", input.checked);
    }
    list.scrollTop = scrollTop;
  });

  const name = document.createElement("span");
  name.className = "session-skills-card-name";
  name.textContent = tSkillName(skill);

  const desc = document.createElement("span");
  desc.className = "session-skills-card-desc";
  const descText = tSkillDesc(skill);
  if (descText) {
    desc.textContent = descText;
  } else {
    desc.hidden = true;
  }

  card.append(input, name, desc);

  if (!skill.globallyEnabled) {
    const badge = document.createElement("span");
    badge.className = "session-skills-card-badge";
    badge.textContent = t("skills.globalOff");
    card.append(badge);
  }

  return card;
}

function renderPopoverList() {
  const list = $("sessionSkillsPopoverList");
  if (!list) return;

  list.replaceChildren();
  const skills = lastPayload?.skills || [];

  for (const skill of skills) {
    list.append(buildSkillCard(skill, list));
  }

  updateResetButton();
  updateSkillButtonBadge();
}

export async function refreshSessionSkillsUi() {
  const sessionId = activeSessionId();
  const tags = $("sessionSkillTags");
  const btn = $("sessionSkillsBtn");
  if (!sessionId) {
    lastPayload = null;
    store.set("sessionSkills", null);
    if (tags) {
      tags.hidden = true;
      tags.replaceChildren();
    }
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
      syncPopoverFromPayload();
    } else {
      renderTags();
    }
  } catch {
    lastPayload = null;
  }
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
    const result = await persistSelection(null);
    if (result?.ok) {
      showToast(t("toast.sessionSkillsReset"), "success");
      if (list) list.scrollTop = scrollTop;
    }
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
