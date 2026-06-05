/**
 * Shared collapsible skill tree DOM helpers (settings + composer).
 */

import { t, tSkillCategory } from "../i18n/index.js";
import { groupSkillsForTree, shouldExpandTreeGroup } from "./session-skill-tree.js";

export function skillTreeGroupLabel(categoryId) {
  if (categoryId === "tools") return t("skills.category.tools");
  if (categoryId === "other") return t("skills.category.other");
  return tSkillCategory(categoryId) || categoryId;
}

export function toggleSkillTreeGroup(groupEl) {
  const expanded = groupEl.dataset.expanded === "true";
  groupEl.dataset.expanded = expanded ? "false" : "true";
  groupEl.classList.toggle("skills-tree-group--expanded", !expanded);
  groupEl.setAttribute("aria-expanded", expanded ? "false" : "true");
}

/** @param {HTMLElement} groupEl */
export function syncSkillTreeGroupSelect(groupEl) {
  const select = groupEl.querySelector(".skills-tree-group-select");
  if (!select) return;
  const rows = groupEl.querySelectorAll(".skills-tree-row");
  let checked = 0;
  rows.forEach((row) => {
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb?.checked) checked += 1;
  });
  if (!rows.length) {
    select.checked = false;
    select.indeterminate = false;
    select.disabled = true;
    return;
  }
  select.disabled = false;
  if (checked === 0) {
    select.checked = false;
    select.indeterminate = false;
  } else if (checked === rows.length) {
    select.checked = true;
    select.indeterminate = false;
  } else {
    select.checked = false;
    select.indeterminate = true;
  }
}

/**
 * @param {{ id: string, skills: object[], enabledCount: number }} group
 * @param {{ totalSkills: number, countLabel: (group: object) => string, renderRow: (skill: object) => HTMLElement, groupSelect?: { onToggle: (group: object, groupEl: HTMLElement, checked: boolean) => void, disabled?: boolean } }} options
 */
export function buildSkillTreeGroup(group, options) {
  const { totalSkills, countLabel, renderRow, groupSelect } = options;
  const expanded = shouldExpandTreeGroup(group, { totalSkills });
  const groupEl = document.createElement("div");
  groupEl.className = "skills-tree-group";
  groupEl.dataset.categoryId = group.id;
  groupEl.dataset.expanded = expanded ? "true" : "false";
  groupEl.setAttribute("role", "treeitem");
  groupEl.setAttribute("aria-expanded", expanded ? "true" : "false");
  if (expanded) groupEl.classList.add("skills-tree-group--expanded");

  const header = document.createElement("button");
  header.type = "button";
  header.className = "skills-tree-group-header";
  header.setAttribute("aria-label", skillTreeGroupLabel(group.id));

  if (groupSelect) {
    const select = document.createElement("input");
    select.type = "checkbox";
    select.className = "skills-tree-group-select";
    select.disabled = Boolean(groupSelect.disabled);
    select.setAttribute(
      "aria-label",
      t("skills.treeToggleGroup", { category: skillTreeGroupLabel(group.id) }),
    );
    select.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    select.addEventListener("change", (event) => {
      event.stopPropagation();
      if (select.disabled) return;
      groupSelect.onToggle(group, groupEl, select.checked);
    });
    header.appendChild(select);
  }

  const caret = document.createElement("span");
  caret.className = "skills-tree-group-caret";
  caret.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "skills-tree-group-label";
  label.textContent = skillTreeGroupLabel(group.id);

  const count = document.createElement("span");
  count.className = "skills-tree-group-count";
  count.textContent = countLabel(group);

  header.append(caret, label, count);
  header.addEventListener("click", (event) => {
    if (event.target instanceof HTMLInputElement) return;
    event.preventDefault();
    event.stopPropagation();
    toggleSkillTreeGroup(groupEl);
  });

  const children = document.createElement("div");
  children.className = "skills-tree-group-children";
  children.setAttribute("role", "group");
  for (const skill of group.skills) {
    children.appendChild(renderRow(skill));
  }

  groupEl.append(header, children);
  if (groupSelect) syncSkillTreeGroupSelect(groupEl);
  return groupEl;
}

/** @param {HTMLElement} container */
export function syncAllSkillTreeGroupSelects(container) {
  container?.querySelectorAll(".skills-tree-group").forEach((groupEl) => {
    syncSkillTreeGroupSelect(groupEl);
  });
}

/**
 * @param {HTMLElement} container
 * @param {object[]} skills
 * @param {{ enabledKey?: string, countLabel: (group: object) => string, renderRow: (skill: object) => HTMLElement, groupSelect?: { onToggle: (group: object, groupEl: HTMLElement, checked: boolean) => void, disabled?: boolean } }} options
 */
export function renderSkillTree(container, skills, options) {
  if (!container) return;
  container.replaceChildren();
  const items = skills || [];
  if (!items.length) return;

  const tree = document.createElement("div");
  tree.className = "skills-tree";
  tree.setAttribute("role", "tree");

  const groups = groupSkillsForTree(items, { enabledKey: options.enabledKey });
  for (const group of groups) {
    tree.appendChild(
      buildSkillTreeGroup(group, {
        totalSkills: items.length,
        countLabel: options.countLabel,
        renderRow: options.renderRow,
        groupSelect: options.groupSelect,
      }),
    );
  }
  container.appendChild(tree);
}
