/**
 * 角色卡 (role card) disclosure of the conversation popover.
 *
 * Naming note — a settled decision, do not re-litigate: the conversation's
 * role is labelled 角色卡, never 角色 and never 说话风格. 角色 answers "谁在
 * 工作", which is exactly the question 智能体 already owns, so the two words
 * collide inside one panel and users cannot tell which control to reach for.
 * 角色卡 names the artifact instead, matches the vocabulary the rest of the
 * product already uses (导入角色卡 / 角色库), and does not collide with the
 * separate persona concept.
 *
 * Structurally an agent CONTAINS a role card, so the popover keeps ONE primary
 * axis — 智能体 — and the role card becomes a secondary property of the
 * conversation, collapsed behind this summary row. The row states the current
 * value (the bound card's name, or Lily 原声) and, when an agent is bound, that
 * the agent is what set it; the disclosure below holds the existing update row,
 * role list and library footer unchanged.
 */
import { effectiveCharacterMode } from "./character-control-model.js";

export function createRoleDisclosure({ getState, getElement, t, getActiveAgent, onToggled }) {
  let expanded = false;

  const summaryRow = () => getElement("characterRoleSummary");
  const disclosure = () => getElement("characterRoleDisclosure");
  const activeAgent = () => (typeof getActiveAgent === "function" ? getActiveAgent() : null);

  /** A non-native role card is pinned to this conversation. */
  function hasRoleCard() {
    const state = getState();
    return effectiveCharacterMode(state) === "character" && Boolean(state.characterRevisionId);
  }

  function roleName() {
    const state = getState();
    return hasRoleCard()
      ? state.characterName || t("character.unnamed")
      : t("character.nativeOption");
  }

  function applyExpansion() {
    const row = summaryRow();
    const body = disclosure();
    if (row) row.setAttribute("aria-expanded", expanded ? "true" : "false");
    if (body) body.hidden = !expanded;
    // The panel's height is shared: expanded, the agent list shrinks to a
    // scannable window so the role cards are not pushed off the bottom edge.
    const panel = getElement("characterPopover");
    if (panel) panel.classList.toggle("is-role-expanded", expanded);
  }

  function setExpanded(next) {
    expanded = Boolean(next);
    applyExpansion();
  }

  function render() {
    const row = summaryRow();
    if (!row) return;
    const label = t("character.roleCard.label");
    const labelEl = row.querySelector(".character-role-summary-label");
    if (labelEl) labelEl.textContent = label;
    const name = roleName();
    const valueEl = getElement("characterRoleSummaryValue");
    if (valueEl) valueEl.textContent = name;
    // When an agent is bound it is the agent that chose the card; say so, but
    // keep the row clickable — the list underneath still switches the card
    // (and the main process then releases the agent).
    const agent = activeAgent();
    const fromEl = getElement("characterRoleSummaryFrom");
    if (fromEl) {
      const suffix = agent?.name ? t("character.roleCard.fromAgent") : "";
      fromEl.textContent = suffix;
      fromEl.hidden = !suffix;
    }
    row.title = agent?.name ? `${label}：${name} · ${t("character.roleCard.fromAgent")}` : `${label}：${name}`;
    row.setAttribute("aria-label", row.title);
    applyExpansion();
  }

  /**
   * Per-popover-open state: collapsed, so 智能体 stays the one question the
   * panel asks. The exception is a role-only user — a card bound with no agent
   * — who would otherwise lose their list behind an extra click.
   */
  function resetForOpen() {
    setExpanded(hasRoleCard() && !activeAgent());
    render();
  }

  function toggle() {
    setExpanded(!expanded);
    // Expanding grows the panel: let the owner re-anchor it inside the viewport.
    onToggled?.(expanded);
  }

  function bind() {
    summaryRow()?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggle();
    });
  }

  return { render, bind, toggle, setExpanded, resetForOpen, isExpanded: () => expanded };
}
