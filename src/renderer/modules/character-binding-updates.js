/**
 * Update-available affordance (Character Worlds Phase 2B, §8).
 *
 * When the active character card has a newer current revision than the
 * session binding's pin, the session control shows a subtle row with an
 * explicit apply action. The hint NEVER changes the pinned snapshot; applying
 * is an explicit set-binding call whose expectedBindingVersion comes from a
 * fresh get-binding read (never the control's possibly-stale copy).
 *
 * Extracted from character-session-control.js (hotspot ratchet): the factory
 * takes the control's state/dispatch/facade callbacks so the reducer and the
 * stale-response guards stay in one place.
 */

import { el } from "./dom.js";
import { t } from "../i18n/index.js";
import { effectiveBindingUpdates } from "./character-control-model.js";
import {
  applyCharacterSwitchNotices,
  getSwitchNoticeCursor,
  SWITCH_NOTICE_LIMIT,
} from "./character-switch-notices.js";

/** Render the subtle update row inside the session-control popover. */
export function renderBindingUpdateRow(row, state) {
  if (!row) return;
  const updates = effectiveBindingUpdates(state);
  row.hidden = !updates;
  row.textContent = "";
  if (!updates) return;
  row.appendChild(el("span", "character-update-label", { textContent: t("character.updateAvailable") }));
  const applyButton = el("button", "character-update-apply", {
    type: "button",
    textContent: t("character.updateApply"),
    "data-action": "apply-update",
  });
  // An in-flight apply/selection holds `selecting`: the button goes inert so
  // a second click cannot issue a duplicate (conflicting) set-binding.
  if (state?.selecting) applyButton.disabled = true;
  row.appendChild(applyButton);
}

/**
 * Replay the durable binding events into conversation-visible switch notices.
 * Display names are resolved main-side; the store dedupes by bindingVersion,
 * so reloads and overlapping fetches render each notice exactly once.
 * Pagination: repository.getBindingEvents pages ASC LIMIT 200, so the first
 * load seeds from the recent tail (the notices window is capped newest-first
 * anyway) and later fetches continue from the max seen event version.
 */
export function createSwitchNoticeLoader({ getState, getFacade }) {
  return async function loadSwitchNotices(sessionId) {
    const api = getFacade();
    if (!api?.getSessionCharacterEvents || !sessionId) return;
    try {
      const seen = getSwitchNoticeCursor(sessionId);
      const afterVersion = seen > 0
        ? seen
        : Math.max(0, (getState().bindingVersion || 0) - SWITCH_NOTICE_LIMIT);
      const res = await api.getSessionCharacterEvents(sessionId, { afterVersion });
      if (sessionId !== getState().sessionId) return;
      if (res?.ok) {
        const eventMax = (Array.isArray(res.events) ? res.events : [])
          .reduce((max, event) => Math.max(max, Number(event?.bindingVersion) || 0), 0);
        applyCharacterSwitchNotices(sessionId, Array.isArray(res.notices) ? res.notices : [], eventMax);
      }
    } catch {
      /* notices are best-effort; the durable events remain for the next load */
    }
  };
}

/** The explicit apply action behind the update row. */
export function createBindingUpdateApplier({ getState, dispatch, getFacade, announce, refresh }) {
  return async function applyBindingUpdates() {
    const state = getState();
    const sessionId = state.sessionId;
    const api = getFacade();
    const updates = effectiveBindingUpdates(state);
    // `selecting` is the shared in-flight guard: a second click is a no-op,
    // and selectMode is blocked for the reverse race while an apply runs.
    if (!sessionId || !api || !updates || state.selecting) return;
    const seq = state.loadSeq;
    const isCurrent = () => sessionId === getState().sessionId && seq === getState().loadSeq;
    dispatch({ type: "updateapply.started", sessionId, seq });
    try {
      const fresh = await api.getSessionCharacterBinding(sessionId);
      if (!isCurrent()) return;
      const binding = fresh?.ok ? fresh.binding : null;
      if (binding?.mode !== "character" || !binding.characterRevisionId) {
        dispatch({ type: "updateapply.finished", sessionId, seq });
        return;
      }
      const res = await api.setSessionCharacterBinding({
        sessionId,
        expectedBindingVersion: binding.bindingVersion,
        mode: "character",
        characterRevisionId: updates.character?.currentRevisionId || binding.characterRevisionId,
      });
      if (!isCurrent()) return;
      if (res?.ok) {
        dispatch({ type: "selection.settled", sessionId, seq, binding: res.binding });
        announce(t("character.status.updateApplied"));
        void refresh(sessionId);
      } else if (res?.error === "CHARACTER_BINDING_CONFLICT") {
        dispatch({ type: "binding.conflict", sessionId, seq, currentBinding: res.currentBinding });
      } else {
        dispatch({ type: "selection.failed", sessionId, seq });
        void refresh(sessionId);
      }
    } catch {
      if (!isCurrent()) return;
      dispatch({ type: "selection.failed", sessionId, seq });
      void refresh(sessionId);
    }
  };
}


/**
 * Composer-owned conversation context selector. Shows native Lily or the
 * pinned character card. It is hidden only when
 * the feature or active session is unavailable.
 */
export function createRoleBannerRenderer({ getState, getElement, monogram, el: createEl, t: translate }) {
  return function renderRoleBanner() {
    const banner = getElement("sessionRoleBanner");
    if (!banner) return;
    const state = getState();
    const isCharacter = state?.available !== false && (state?.mode || "native") === "character"
      && state.characterRevisionId;
    const visible = state?.available !== false && Boolean(state?.sessionId);
    banner.hidden = !visible;
    if (!visible) return;
    const name = isCharacter
      ? state.characterName || translate("character.unnamed")
      : translate("character.nativeOption");
    banner.querySelector(".session-role-banner-avatar").textContent = monogram(name);
    banner.querySelector(".session-role-banner-name").textContent = name;
    banner.classList.toggle("is-character", Boolean(isCharacter));
    const badges = banner.querySelector(".session-role-banner-badges");
    badges.textContent = "";
    const contextLabels = [];
    if (isCharacter) {
      const applicationKey = state.application?.status === "applied"
        ? "character.application.applied"
        : state.application?.status === "bypassed"
          ? "character.application.bypassed"
          : "character.application.selected";
      const label = translate(applicationKey);
      contextLabels.push(label);
      badges.appendChild(createEl("span", "character-application-status", { textContent: label }));
    }
    const contextSummary = contextLabels.length ? ` · ${contextLabels.join(" · ")}` : "";
    banner.title = `${name}${contextSummary} · ${translate("character.roleBannerTitle")}`;
    banner.setAttribute("aria-label", banner.title);
  };
}
