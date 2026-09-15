/**
 * Role (角色) list of the conversation popover.
 *
 * Extracted from character-session-control.js (architecture ratchet). Renders
 * the native row, official roles grouped by category, and the recent local
 * roles; when an agent is bound to the conversation, a note above the list
 * says the agent set the current role and that picking another role releases
 * the agent (the rows stay clickable — the main process reports the release
 * through `agentDeactivated` and the control announces it).
 */
import { effectiveCharacterMode } from "./character-control-model.js";
import { appendCharacterOptionCopy } from "./official-character-picker.js";

const USER_ROUND_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>';
const MAX_LISTED_CHARACTERS = 8;

export function createRoleListRenderer({ getState, getElement, el, t, monogram, getActiveAgent }) {
  function optionRow({ mode, character, checked }) {
    const row = el("button", "character-option", {
      type: "button",
      role: "menuitemradio",
      "aria-checked": checked ? "true" : "false",
    });
    if (mode === "native") {
      row.dataset.characterMode = "native";
      row.appendChild(el("span", "character-option-icon", { innerHTML: USER_ROUND_SVG }));
      row.appendChild(el("span", "character-option-name", { textContent: t("character.nativeOption") }));
    } else {
      if (character.officialId) row.dataset.characterOfficialId = character.officialId;
      if (character.currentRevisionId) row.dataset.characterRevisionId = character.currentRevisionId;
      const swatch = el("span", "character-option-swatch", { textContent: monogram(character.displayName) });
      swatch.setAttribute("aria-hidden", "true");
      row.appendChild(swatch);
      const name = character.displayName || t("character.unnamed");
      appendCharacterOptionCopy(row, character, name, el);
      if (character.official) {
        row.appendChild(el("span", "character-option-official", { textContent: t("character.officialBadge") }));
      }
    }
    row.appendChild(el("span", "character-option-check", { textContent: "✓" }));
    return row;
  }

  function focusKeyOf(active, list) {
    if (!active || !list.contains(active)) return null;
    if (active.dataset?.characterMode) return `mode:${active.dataset.characterMode}`;
    if (active.dataset?.characterRevisionId) return `rev:${active.dataset.characterRevisionId}`;
    if (active.dataset?.characterOfficialId) return `official:${active.dataset.characterOfficialId}`;
    return null;
  }

  function restoreFocus(list, focusKey) {
    if (!focusKey || list.contains(document.activeElement)) return;
    const selector = focusKey.startsWith("mode:")
      ? `[data-character-mode="${focusKey.slice(5)}"]`
      : focusKey.startsWith("official:")
        ? `[data-character-official-id="${CSS.escape(focusKey.slice(9))}"]`
        : `[data-character-revision-id="${CSS.escape(focusKey.slice(4))}"]`;
    list.querySelector(selector)?.focus();
  }

  /** The agent ↔ role cross-reference: only when an agent is bound. */
  function renderAgentNote(list) {
    const agent = getActiveAgent?.();
    if (!agent?.name) return;
    list.appendChild(el("div", "character-list-heading character-role-agent-note", {
      textContent: t("character.agent.roleHeadingNote", { name: agent.name }),
      "data-role-agent-note": "true",
      role: "note",
    }));
  }

  return function renderList() {
    const list = getElement("characterList");
    if (!list) return;
    const state = getState();
    // Remember the focused row's key so focus survives the re-render.
    const focusKey = focusKeyOf(document.activeElement, list);
    list.textContent = "";
    renderAgentNote(list);
    const isCharacter = effectiveCharacterMode(state) === "character" && state.characterRevisionId;
    list.appendChild(optionRow({ mode: "native", checked: !isCharacter }));
    const official = state.characters.filter((character) => character.official);
    const characters = state.characters.filter((character) => !character.official).slice(0, MAX_LISTED_CHARACTERS);
    if (official.length) {
      const groups = new Map();
      for (const character of official) {
        const groupId = character.categoryId || "uncategorized";
        if (!groups.has(groupId)) groups.set(groupId, []);
        groups.get(groupId).push(character);
      }
      for (const [groupId, groupCharacters] of groups) {
        const categoryKey = `character.library.category.${groupId}`;
        const categoryLabel = t(categoryKey) === categoryKey ? t("character.officialHeading") : t(categoryKey);
        list.appendChild(el("div", "character-list-heading", { textContent: categoryLabel }));
        for (const character of groupCharacters) {
          list.appendChild(optionRow({ character, checked: state.characterRevisionId === character.currentRevisionId }));
        }
      }
    }
    if (!characters.length) {
      if (!official.length) list.appendChild(el("div", "character-list-empty", { textContent: t("character.emptyLibrary") }));
    } else {
      list.appendChild(el("div", "character-list-heading", { textContent: t("character.recentHeading") }));
      for (const character of characters) {
        list.appendChild(optionRow({ character, checked: state.characterRevisionId === character.currentRevisionId }));
      }
    }
    restoreFocus(list, focusKey);
  };
}
