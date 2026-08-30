import { t } from "../i18n/index.js";

function byId(id) { return document.getElementById(id); }

function renderInbox(result, onOpen = () => {}) {
  const inbox = byId("collaborationInbox");
  if (!inbox) return;
  const rows = Array.isArray(result?.conversations) ? result.conversations : Array.isArray(result?.rows) ? result.rows : [];
  inbox.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "collaboration-empty";
    empty.textContent = t("collaboration.empty");
    inbox.append(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "collaboration-inbox-item";
    item.textContent = String(row.title || row.displayName || row.id || "");
    item.addEventListener("click", () => onOpen(String(row.id || "")));
    inbox.append(item);
  }
}

/**
 * A deliberately thin shell: normal workbench DOM remains mounted and is only
 * visually switched, so turning the feature off restores the current chat
 * without destroying a running turn or composer state.
 */
export function initCollaborationCenter({ getPolicy = () => window.assistantClient?.getAppPolicy?.() } = {}) {
  const nav = byId("collaborationNavButton");
  const back = byId("workbenchNavButton");
  const shell = byId("centerPanel");
  const panel = byId("collaborationCenter");
  if (!nav || !back || !shell || !panel) return { refresh: async () => false };
  const status = byId("collaborationStatus");
  const live = byId("collaborationLive");
  const scopeBadge = byId("collaborationScopeBadge");
  let bootstrapAttempted = false;

  const setActive = (active) => {
    shell.classList.toggle("collaboration-active", active);
    panel.hidden = !active;
    nav.setAttribute("aria-current", active ? "page" : "false");
    if (active) byId("collaborationInboxColumn")?.focus?.();
  };
  const load = async () => {
    let result = await window.assistantClient?.collaboration?.list?.().catch(() => null);
    if (!bootstrapAttempted && result?.ok === true && Array.isArray(result.conversations) && result.conversations.length === 0) {
      bootstrapAttempted = true;
      await window.assistantClient?.collaboration?.bootstrap?.().catch(() => null);
      result = await window.assistantClient?.collaboration?.list?.().catch(() => result);
    }
    renderInbox(result, async (conversationId) => {
      const opened = await window.assistantClient?.collaboration?.open?.(conversationId).catch(() => null);
      const scope = String(opened?.conversation?.scopeId || "");
      if (scopeBadge) scopeBadge.textContent = t(scope.startsWith("team:") ? "collaboration.scopeTeam" : "collaboration.scopePersonal");
      if (live) live.textContent = String(opened?.conversation?.title || t("collaboration.conversation"));
    });
    const available = result?.ok === true;
    if (status) { status.textContent = t(available ? "collaboration.statusAvailable" : "collaboration.statusUnavailable"); status.classList.toggle("is-available", available); }
  };
  nav.addEventListener("click", () => { setActive(true); void load(); });
  back.addEventListener("click", () => setActive(false));

  async function refresh() {
    const policy = await Promise.resolve(getPolicy()).catch(() => null);
    const enabled = policy?.collaboration?.enabled === true;
    nav.hidden = !enabled;
    if (!enabled) { setActive(false); if (status) status.textContent = t("collaboration.statusUnavailable"); }
    return enabled;
  }
  const unsubscribe = window.assistantClient?.collaboration?.onStateChange?.((payload) => {
    void refresh().then((enabled) => {
      const available = payload?.state?.ok === true;
      if (status) { status.textContent = t(available ? "collaboration.statusAvailable" : "collaboration.statusUnavailable"); status.classList.toggle("is-available", available); }
      nav.hidden = !enabled || !available;
      if (!enabled || !available) setActive(false);
      else if (!panel.hidden) void load();
      if (live) live.textContent = t(available ? "collaboration.statusAvailable" : "collaboration.statusUnavailable");
    });
  });
  void refresh();
  return { refresh, show: () => { setActive(true); void load(); }, hide: () => setActive(false), destroy: () => unsubscribe?.() };
}
