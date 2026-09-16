/**
 * 智能体 section of the conversation popover + banner decoration.
 *
 * Extracted so character-session-control.js keeps its role-only reducer.
 * The section is an observability/safety shell: it lists EVERY agent the user
 * can pick (active, then installed, then official, then distributed pending)
 * with a one-line explainer of what an agent is and compact capability chips
 * per row, switches with a CAS-guarded activate (expectedBindingVersion from
 * a fresh agents:get-session), offers "无智能体（原生 Lily）" to deactivate,
 * and a "管理智能体库" entry into the library. Everything fails open: any
 * facade error hides the section and leaves the role control untouched.
 */

import {
  buildAgentLibraryItems,
  shortlistAgents,
  agentCapabilityChips,
  agentIconGlyph,
  agentMonogram,
} from "./agent-library-model.js";
import {
  activateAgentWithRetry,
  deactivateAgentWithRetry,
  announceAgentBindingChanged,
} from "./agent-library-actions.js";

const AGENT_BINDING_CHANGED_EVENT = "lily:agent-binding-changed";

export function createAgentSessionSection({ getFacade, getElement, el, t, getSessionId, onBindingChanged, openLibrary, announce, onRendered }) {
  const state = {
    sessionId: null,
    loadSeq: 0,
    available: false,
    items: [],
    session: null, // agents:get-session projection for the current session
    switching: false,
    notice: "",
  };

  const section = () => getElement("characterAgentSection");
  const api = () => (typeof getFacade === "function" ? getFacade() : null);

  /** Current binding as the banner needs it: {icon, name} or null. */
  function activeAgent() {
    const session = state.session;
    if (!state.available || !session?.active || !session.binding?.agentId) return null;
    const name = session.agent?.name || session.binding.displayName || "";
    return { id: session.binding.agentId, name, icon: agentIconGlyph(session.agent?.icon || session.agent?.summary?.icon || "") };
  }

  function isCurrent(sessionId, seq) {
    return sessionId === state.sessionId && seq === state.loadSeq;
  }

  async function load(sessionId = getSessionId?.()) {
    if (sessionId !== state.sessionId) {
      state.sessionId = sessionId || null;
      state.session = null;
      state.notice = "";
    }
    const seq = ++state.loadSeq;
    const facade = api();
    if (!facade || !sessionId) {
      state.available = false;
      state.items = [];
      render();
      return;
    }
    try {
      const [session, list] = await Promise.all([facade.getSession(sessionId), facade.list({})]);
      if (!isCurrent(sessionId, seq)) return;
      if (!session?.ok || !list?.ok || list.disabled || session.enabled === false) {
        state.available = false;
        state.items = [];
        state.session = session?.ok ? session : null;
        render();
        return;
      }
      state.available = true;
      state.session = session;
      const activeAgentId = session.active && session.binding?.agentId ? session.binding.agentId : "";
      state.items = buildAgentLibraryItems(list, { activeAgentId });
      render();
    } catch {
      if (!isCurrent(sessionId, seq)) return;
      state.available = false;
      state.items = [];
      render();
    }
  }

  function row({ item = null, none = false, checked }) {
    const button = el("button", "character-option character-agent-option", {
      type: "button",
      role: "menuitemradio",
      "aria-checked": checked ? "true" : "false",
    });
    if (none) {
      button.dataset.agentMode = "none";
      button.appendChild(el("span", "character-option-swatch character-agent-swatch is-none", { textContent: "∅", "aria-hidden": "true" }));
      const copy = el("span", "character-option-copy");
      copy.appendChild(el("span", "character-option-name", { textContent: t("character.agent.noneOption") }));
      button.appendChild(copy);
    } else {
      if (item.installed) button.dataset.agentId = item.installedAgentId || item.id;
      else if (item.official) button.dataset.agentOfficialId = item.officialId;
      else if (item.distributed) button.dataset.agentPackageId = item.packageId || item.id;
      button.appendChild(el("span", `character-option-swatch character-agent-swatch${item.icon ? " is-agent-icon" : ""}`, {
        textContent: item.icon || agentMonogram(item.name), "aria-hidden": "true",
      }));
      const copy = el("span", "character-option-copy");
      const name = item.name || t("character.unnamed");
      copy.appendChild(el("span", "character-option-name", { textContent: name, title: name }));
      if (item.description) copy.appendChild(el("span", "character-option-tagline", { textContent: item.description, title: item.description }));
      const chips = agentCapabilityChips(item, t);
      if (chips.length) {
        const caps = el("span", "character-agent-caps", { "data-agent-caps": "true" });
        for (const chip of chips) caps.appendChild(el("span", `character-agent-cap is-${chip.key}`, { textContent: chip.text, title: chip.text, "data-agent-cap": chip.key }));
        copy.appendChild(caps);
      }
      button.appendChild(copy);
      if (item.official) button.appendChild(el("span", "character-option-official", { textContent: t("character.officialBadge") }));
      else if (item.distributed) button.appendChild(el("span", "character-option-official", { textContent: t("character.agent.badgeDistributed") }));
    }
    button.appendChild(el("span", "character-option-check", { textContent: "✓" }));
    if (state.switching) button.disabled = true;
    return button;
  }

  function render() {
    const host = section();
    if (!host) return;
    const active = activeAgent();
    const listed = shortlistAgents(state.items);
    const visible = state.available && (listed.length > 0 || Boolean(active));
    host.hidden = !visible;
    host.textContent = "";
    if (!visible) {
      onRendered?.();
      return;
    }
    host.appendChild(el("div", "character-list-heading character-agent-heading", { textContent: t("character.agent.sectionHeading") }));
    host.appendChild(el("p", "character-agent-explainer", { textContent: t("character.agent.sectionExplainer"), "data-agent-explainer": "true" }));
    if (state.notice) host.appendChild(el("div", "character-popover-notice character-agent-notice", { textContent: state.notice }));
    const list = el("div", "character-agent-list", { role: "menu" });
    list.appendChild(row({ none: true, checked: !active }));
    for (const item of listed) list.appendChild(row({ item, checked: Boolean(active) && item.installedAgentId === active.id }));
    host.appendChild(list);
    const footer = el("div", "character-agent-footer");
    footer.appendChild(el("button", "character-footer-btn character-agent-manage", {
      type: "button", textContent: t("character.agent.manageLibrary"), "data-agent-manage": "true",
    }));
    host.appendChild(footer);
    onRendered?.();
  }

  function noticeFor(error) {
    if (error === "BUSY") return t("character.agent.busy");
    if (error === "AGENT_BINDING_CONFLICT") return t("character.agent.conflict");
    return t("character.agent.unavailable");
  }

  async function switchTo(target) {
    const sessionId = state.sessionId;
    const facade = api();
    if (!sessionId || !facade || state.switching) return;
    const seq = state.loadSeq;
    state.switching = true;
    state.notice = "";
    render();
    try {
      const res = target
        ? await activateAgentWithRetry(facade, {
          sessionId,
          agentId: target.installed ? target.installedAgentId || target.id : "",
          officialId: target.official ? target.officialId : "",
          translate: t,
        })
        : await deactivateAgentWithRetry(facade, { sessionId });
      if (!isCurrent(sessionId, seq)) return;
      state.switching = false;
      if (res?.ok) {
        const name = res.agent?.name || target?.name || "";
        announce?.(target
          ? (res.degradedLabels?.length
            ? t("character.agent.activatedDegraded", { name, dimensions: res.degradedLabels.join("、") })
            : t("character.agent.activated", { name }))
          : t("character.agent.removed", { name: activeAgent()?.name || "" }));
        // Degradation is never hidden: keep it visible inside the popover too.
        state.notice = target && res.degradedLabels?.length
          ? t("character.agent.activatedDegraded", { name, dimensions: res.degradedLabels.join("、") })
          : "";
        announceAgentBindingChanged({ sessionId, agentId: res.binding?.agentId || null });
        await load(sessionId);
        onBindingChanged?.({ sessionId, agentId: res.binding?.agentId || null, degraded: Boolean(res.degradedLabels?.length) });
      } else {
        state.notice = noticeFor(res?.error);
        render();
      }
    } catch {
      if (!isCurrent(sessionId, seq)) return;
      state.switching = false;
      state.notice = t("character.agent.unavailable");
      render();
    }
  }

  function bind() {
    const host = section();
    if (!host) return;
    host.addEventListener("click", (event) => {
      if (event.target.closest("[data-agent-manage]")) {
        openLibrary?.();
        return;
      }
      const button = event.target.closest("[data-agent-mode], [data-agent-id], [data-agent-official-id], [data-agent-package-id]");
      if (!button || button.disabled) return;
      if (button.dataset.agentMode === "none") {
        if (activeAgent()) void switchTo(null);
        return;
      }
      if (button.dataset.agentPackageId) {
        // Distributed but not yet synced to this machine: say so, never activate.
        state.notice = t("character.agent.distributedPending");
        render();
        return;
      }
      const target = state.items.find((item) => (button.dataset.agentId && (item.installedAgentId || item.id) === button.dataset.agentId)
        || (button.dataset.agentOfficialId && item.officialId === button.dataset.agentOfficialId));
      if (target && !target.active) void switchTo(target);
    });
    if (typeof window !== "undefined") {
      window.addEventListener(AGENT_BINDING_CHANGED_EVENT, (event) => {
        const sessionId = event?.detail?.sessionId;
        if (sessionId && sessionId === state.sessionId) void load(sessionId);
      });
    }
  }

  /**
   * Banner decoration: when an agent is bound, the composer banner shows its
   * icon + name (the role name is the fallback that renderRoleBanner already
   * painted, so we only override when we have a name).
   */
  function decorateBanner(banner) {
    if (!banner) return;
    const active = activeAgent();
    banner.classList.toggle("is-agent", Boolean(active));
    if (!active || !active.name) {
      delete banner.dataset.agentId;
      // The role banner renderer already painted 角色卡 as the kind label.
      return;
    }
    banner.dataset.agentId = active.id;
    const avatar = banner.querySelector(".session-role-banner-avatar");
    const kind = banner.querySelector(".session-role-banner-kind");
    const name = banner.querySelector(".session-role-banner-name");
    if (kind) kind.textContent = t("character.bannerKindAgent");
    if (avatar) {
      avatar.textContent = active.icon || agentMonogram(active.name);
      avatar.classList.toggle("is-agent-icon", Boolean(active.icon));
    }
    if (name) name.textContent = active.name;
    const title = t("character.agent.bannerActive", { name: active.name });
    banner.title = `${title} · ${banner.title}`;
    banner.setAttribute("aria-label", banner.title);
  }

  return {
    load,
    render,
    bind,
    decorateBanner,
    activeAgent,
    /** Test hook. */
    getState: () => ({ ...state, items: [...state.items] }),
  };
}
