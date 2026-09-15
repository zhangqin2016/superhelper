/**
 * Wires the 智能体 popover section into the conversation role control.
 *
 * Extracted from character-session-control.js (architecture ratchet): the
 * control hands over its closures (state, loaders, banner renderer, popover
 * helpers) and gets back the section plus two small helpers. Agent activation
 * also rebinds the role, so a successful switch re-reads the role binding
 * through the same loader the quick selector uses; renderRoleBanner rebuilds
 * the banner title from the role binding and decorateBanner layers the agent
 * on top, so the decoration never stacks.
 */
import { createAgentSessionSection } from "./agent-session-section.js";
import { positionCharacterPopover } from "./character-popover-position.js";

export function wireAgentSessionSection({
  getState, getElement, el, t, announce, loadBinding, closePopover, renderRoleBanner, renderRoleList, btn, popover, openLibrary,
}) {
  const decorate = () => {
    renderRoleBanner();
    section.decorateBanner(btn());
  };
  const section = createAgentSessionSection({
    getFacade: () => window.assistantClient?.agents || null,
    getElement,
    el,
    t,
    getSessionId: () => getState().sessionId,
    announce,
    onBindingChanged: ({ sessionId }) => {
      closePopover();
      if (sessionId === getState().sessionId) void loadBinding(sessionId);
      decorate();
    },
    openLibrary: () => {
      closePopover();
      void openLibrary({ tab: "agents" });
    },
    onRendered: () => {
      decorate();
      renderRoleList?.(); // the role heading note names the bound agent
      const p = popover();
      const b = btn();
      if (p && !p.hidden && b) requestAnimationFrame(() => positionCharacterPopover({ panel: p, trigger: b }));
    },
  });

  // A turn can rebind the agent through natural language (lily_agent_draft);
  // re-read the agent binding once the session settles back to idle.
  let lastRuntimePhase = null;
  function observeRuntime(runtime) {
    const phase = runtime?.phase || "idle";
    const sessionId = getState().sessionId;
    if (sessionId && lastRuntimePhase && lastRuntimePhase !== "idle" && phase === "idle") void section.load(sessionId);
    lastRuntimePhase = phase;
  }

  return { section, observeRuntime, decorateBanner: () => section.decorateBanner(btn()) };
}
