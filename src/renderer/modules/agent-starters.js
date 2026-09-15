/**
 * Agent starter chips above the composer.
 *
 * Shown only while the ACTIVE session has an agent bound AND the conversation
 * is still empty (no committed/loaded messages, no live turn). Click puts the
 * starter text into the composer and focuses it — the send stays a human act.
 * Reads go through window.assistantClient.agents.getSession, cached per
 * session and invalidated on the agent-binding-changed event; any facade
 * failure simply hides the chips.
 */

import { $, el } from "./dom.js";
import store from "./state.js";
import { getRuntimeSession, subscribeRuntime } from "./session-runtime-store.js";

const MAX_STARTERS = 3;
const AGENT_BINDING_CHANGED_EVENT = "lily:agent-binding-changed";

const facade = () => window.assistantClient?.agents || null;
const cache = new Map(); // sessionId → { starters: string[], name }
let loadSeq = 0;

/** Pure: is the session's conversation empty from the renderer's view? */
export function isConversationEmpty({ conversation, runtime } = {}) {
  const loaded = Array.isArray(conversation) ? conversation.length : 0;
  const committed = Array.isArray(runtime?.committedMessages) ? runtime.committedMessages.length : 0;
  const busy = Boolean(runtime?.liveTurn) || (runtime?.phase && runtime.phase !== "idle");
  return loaded === 0 && committed === 0 && !busy;
}

function hide(bar) {
  if (!bar) return;
  bar.hidden = true;
  bar.replaceChildren();
}

function paint(bar, starters) {
  bar.replaceChildren();
  for (const text of starters.slice(0, MAX_STARTERS)) {
    const chip = el("button", "agent-starter-chip", { type: "button", textContent: text, title: text });
    chip.dataset.agentStarter = "true";
    chip.addEventListener("click", () => {
      const input = $("promptInput");
      if (!input) return;
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    });
    bar.appendChild(chip);
  }
  bar.hidden = bar.childElementCount === 0;
}

async function loadStarters(sessionId) {
  const api = facade();
  if (!api || !sessionId) return null;
  const res = await api.getSession(sessionId);
  if (!res?.ok || !res.active || !res.binding?.agentId) return { starters: [], name: "" };
  const starters = Array.isArray(res.agent?.summary?.starters)
    ? res.agent.summary.starters.filter((entry) => typeof entry === "string" && entry.trim()).slice(0, MAX_STARTERS)
    : [];
  return { starters, name: res.agent?.name || "" };
}

/** Re-evaluate visibility for the active session (cheap when cached). */
export async function refreshAgentStarters() {
  const bar = $("agentStarters");
  if (!bar) return;
  const sessionId = store.get("activeSessionId");
  if (!sessionId || !facade()) return hide(bar);
  const empty = isConversationEmpty({ conversation: store.get("conversation"), runtime: getRuntimeSession(sessionId) });
  if (!empty) return hide(bar);
  if (!cache.has(sessionId)) {
    const seq = ++loadSeq;
    try {
      const loaded = await loadStarters(sessionId);
      if (seq !== loadSeq || store.get("activeSessionId") !== sessionId) return;
      if (loaded) cache.set(sessionId, loaded);
    } catch {
      if (seq !== loadSeq) return;
      return hide(bar);
    }
    // The conversation may have started while the read was in flight.
    if (!isConversationEmpty({ conversation: store.get("conversation"), runtime: getRuntimeSession(sessionId) })) return hide(bar);
  }
  const entry = cache.get(sessionId);
  if (!entry?.starters?.length) return hide(bar);
  paint(bar, entry.starters);
}

export function initAgentStarters() {
  const bar = $("agentStarters");
  if (!bar || !facade()) {
    if (bar) bar.hidden = true;
    return;
  }
  store.on("activeSessionId", () => void refreshAgentStarters());
  store.on("conversation", () => void refreshAgentStarters());
  subscribeRuntime(() => void refreshAgentStarters());
  window.addEventListener(AGENT_BINDING_CHANGED_EVENT, (event) => {
    const sessionId = event?.detail?.sessionId;
    if (sessionId) cache.delete(sessionId);
    else cache.clear();
    void refreshAgentStarters();
  });
  void refreshAgentStarters();
}

/** Test hook: forget cached bindings. */
export function resetAgentStartersCache() {
  cache.clear();
}
