/**
 * Facade operations for the 智能体 (agent) tab. Mirrors
 * ./character-library-actions.js: dependencies are injected, every failure
 * fails open with a quiet localized notice and leaves the session unchanged.
 *
 * Contract: window.assistantClient.agents (src/preload.js) →
 * src/main/ipc-agents.js. Activation is CAS-guarded by expectedBindingVersion
 * (from a fresh agents:get-session read); a binding conflict re-reads once
 * and retries; BUSY and AGENTS_UNAVAILABLE map to their own notices; a
 * degraded receipt is always surfaced, never hidden.
 */

import { degradedDimensionLabels } from "./agent-library-model.js";

const AGENT_BINDING_CHANGED_EVENT = "lily:agent-binding-changed";

function noticeForError(code) {
  if (code === "BUSY") return "agent_busy";
  if (code === "AGENTS_UNAVAILABLE") return "agent_unavailable";
  if (code === "AGENT_BINDING_CONFLICT") return "agent_conflict";
  return "action_failed";
}

export function announceAgentBindingChanged(detail) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(AGENT_BINDING_CHANGED_EVENT, { detail }));
}

/**
 * Activate an agent into a session with a fresh CAS version and one retry on
 * conflict. Shared by the library detail and the composer popover. Returns
 * the facade result (ok/error) or null when the facade is missing.
 */
export async function activateAgentWithRetry(api, { sessionId, agentId, officialId, translate }) {
  if (!api || !sessionId || (!agentId && !officialId)) return null;
  const read = await api.getSession(sessionId);
  if (!read?.ok) return { ok: false, error: read?.error || "AGENTS_UNAVAILABLE" };
  if (read.enabled === false) return { ok: false, error: "AGENTS_UNAVAILABLE" };
  const attempt = (expectedBindingVersion) => api.activate({
    sessionId,
    agentId: agentId || undefined,
    officialId: agentId ? undefined : officialId,
    expectedBindingVersion,
  });
  let res = await attempt(read.binding?.bindingVersion);
  if (!res?.ok && res?.error === "AGENT_BINDING_CONFLICT") {
    const fresh = await api.getSession(sessionId);
    if (fresh?.ok) res = await attempt(fresh.binding?.bindingVersion);
  }
  if (res?.ok) res.degradedLabels = degradedDimensionLabels(res.receipt, translate);
  return res;
}

export async function deactivateAgentWithRetry(api, { sessionId }) {
  if (!api || !sessionId) return null;
  const read = await api.getSession(sessionId);
  if (!read?.ok) return { ok: false, error: read?.error || "AGENTS_UNAVAILABLE" };
  let res = await api.deactivate(sessionId, read.binding?.bindingVersion);
  if (!res?.ok && res?.error === "AGENT_BINDING_CONFLICT") {
    const fresh = await api.getSession(sessionId);
    if (fresh?.ok) res = await api.deactivate(sessionId, fresh.binding?.bindingVersion);
  }
  return res;
}

export function createAgentLibraryActions(ctx) {
  const { facade, getState, dispatch, setNotice, settle, getActiveSessionId, onActivated, translate } = ctx;
  const t = typeof translate === "function" ? translate : (key) => key;

  /** Which agent the ACTIVE session is bound to (empty when none/unavailable). */
  async function readActiveAgentId(api) {
    const sessionId = getActiveSessionId?.();
    if (!sessionId || typeof api?.getSession !== "function") return "";
    try {
      const res = await api.getSession(sessionId);
      return res?.ok && res.active && typeof res.binding?.agentId === "string" ? res.binding.agentId : "";
    } catch {
      return "";
    }
  }

  async function loadAgents() {
    const api = facade();
    const current = () => getState().open && getState().tab === "agents";
    if (!api) {
      if (current()) {
        dispatch({ type: "items.loaded", tab: "agents", items: {} });
        setNotice("agent_unavailable");
      }
      return;
    }
    try {
      const includeArchived = getState().groupId === "archived" || getState().groupId === "all";
      const [list, activeAgentId] = await Promise.all([
        api.list({ includeArchived }),
        readActiveAgentId(api),
      ]);
      if (!current()) return;
      if (!list?.ok) {
        dispatch({ type: "items.loaded", tab: "agents", items: {} });
        setNotice(noticeForError(list?.error));
        return;
      }
      dispatch({ type: "items.loaded", tab: "agents", items: list, activeAgentId });
      if (list.disabled) setNotice("agent_disabled");
    } catch {
      if (current()) {
        dispatch({ type: "items.loaded", tab: "agents", items: {} });
        setNotice("load_failed");
      }
    }
  }

  // The list payload already carries the full summary, so the detail is a
  // synchronous projection — no second round-trip, no loading flash.
  function openDetail(item) {
    if (!item?.id) return;
    dispatch({ type: "detail.selected", itemId: item.id });
    dispatch({ type: "detail.loaded", itemId: item.id, detail: item });
  }

  async function activateItem(item) {
    const api = facade();
    const sessionId = getActiveSessionId?.();
    if (!api || !sessionId || !item || getState().activation.status === "running") return;
    if (item.distributed && !item.installed) {
      // Not synced yet: the package will appear once the registry refresh
      // installs it; activation cannot invent a local entity.
      setNotice("agent_distributed_pending");
      return;
    }
    dispatch({ type: "activation.started", itemId: item.id });
    try {
      const res = await activateAgentWithRetry(api, {
        sessionId,
        agentId: item.installed ? item.installedAgentId || item.id : "",
        officialId: item.official ? item.officialId : "",
        translate: t,
      });
      if (res?.ok) {
        const name = res.agent?.name || item.name;
        dispatch({ type: "activation.settled", itemId: item.id });
        if (res.degradedLabels?.length) {
          setNotice("agent_activated_degraded", { name, dimensions: res.degradedLabels.join("、") });
        } else {
          setNotice("agent_activated", { name });
        }
        await loadAgents();
        announceAgentBindingChanged({ sessionId, agentId: res.binding?.agentId || null });
        onActivated?.({ sessionId, agent: true, keepOpen: Boolean(res.degradedLabels?.length) });
      } else {
        dispatch({ type: "activation.failed", itemId: item.id, error: res?.error || "ACTIVATION_FAILED" });
        setNotice(noticeForError(res?.error));
      }
    } catch {
      dispatch({ type: "activation.failed", itemId: item.id, error: "ACTIVATION_FAILED" });
      setNotice("action_failed");
    }
  }

  async function deactivateItem(item) {
    const api = facade();
    const sessionId = getActiveSessionId?.();
    if (!api || !sessionId || getState().activation.status === "running") return;
    dispatch({ type: "activation.started", itemId: item?.id || "" });
    try {
      const res = await deactivateAgentWithRetry(api, { sessionId });
      if (res?.ok) {
        dispatch({ type: "activation.settled", itemId: item?.id || "" });
        setNotice("agent_removed", { name: item?.name || "" });
        await loadAgents();
        announceAgentBindingChanged({ sessionId, agentId: null });
        onActivated?.({ sessionId, agent: true });
      } else {
        dispatch({ type: "activation.failed", itemId: item?.id || "", error: res?.error || "DEACTIVATION_FAILED" });
        setNotice(noticeForError(res?.error));
      }
    } catch {
      dispatch({ type: "activation.failed", itemId: item?.id || "", error: "DEACTIVATION_FAILED" });
      setNotice("action_failed");
    }
  }

  async function exportItem(item) {
    const api = facade();
    if (!api || !item?.installed) return;
    try {
      const res = await api.exportAgent(item.installedAgentId || item.id);
      if (res?.ok) setNotice("agent_exported", { name: item.name });
      else if (res?.error !== "CANCELED") setNotice(noticeForError(res?.error));
    } catch {
      setNotice("action_failed");
    }
  }

  async function startImport() {
    const api = facade();
    if (!api || getState().busy) return;
    dispatch({ type: "busy.set", busy: true });
    try {
      const res = await api.importAgent();
      dispatch({ type: "busy.set", busy: false });
      if (res?.ok) {
        setNotice("agent_imported", { name: res.agent?.name || "" });
        await loadAgents();
      } else if (res?.error !== "CANCELED") {
        setNotice(res?.error === "AGENT_FILE_INVALID" || res?.error === "AGENT_FILE_TOO_LARGE" || res?.error === "INVALID_INPUT"
          ? "agent_import_failed"
          : noticeForError(res?.error));
      }
    } catch {
      dispatch({ type: "busy.set", busy: false });
      setNotice("agent_import_failed");
    }
  }

  /** archive / restore behind the shared inline confirm bar. */
  async function confirmAction() {
    const api = facade();
    const confirm = getState().confirm;
    if (!api || !confirm || confirm.kind !== "agent" || getState().busy) return;
    dispatch({ type: "busy.set", busy: true });
    try {
      const res = await api.archive(confirm.entityId, confirm.action === "restore" ? "restore" : "archive");
      if (res?.ok) {
        settle("mutation.settled", confirm.action === "restore" ? "agent_restored" : "agent_archived", { name: confirm.name });
        await loadAgents();
      } else {
        settle("mutation.failed", noticeForError(res?.error));
      }
    } catch {
      settle("mutation.failed", "action_failed");
    }
  }

  return { loadAgents, openDetail, activateItem, deactivateItem, exportItem, startImport, confirmAction };
}
