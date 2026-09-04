/**
 * Per-account conversation preferences — pin, mute, delete — the way WeChat
 * lets you 置顶 / 免打扰 / 删除 a chat from its right-click menu.
 *
 * These are device-local (localStorage, keyed by account) for now: they change
 * how the list is ordered and shown, never the messages themselves. A deleted
 * conversation is only hidden; it returns the moment a newer message arrives,
 * so nothing is lost.
 */
const KEY = (accountId) => `lily.collab.convPrefs.${accountId || "anon"}`;
const EMPTY = { pinned: {}, muted: {}, hidden: {} };

export function createConversationPrefs(accountId, storage = safeStorage()) {
  let state = load();

  function load() {
    try {
      const raw = storage?.getItem?.(KEY(accountId));
      const parsed = raw ? JSON.parse(raw) : null;
      return {
        pinned: obj(parsed?.pinned), muted: obj(parsed?.muted), hidden: obj(parsed?.hidden), hiddenMessages: obj(parsed?.hiddenMessages),
      };
    } catch { return { pinned: {}, muted: {}, hidden: {}, hiddenMessages: {} }; }
  }
  function persist() {
    try { storage?.setItem?.(KEY(accountId), JSON.stringify(state)); } catch { /* private mode / quota: prefs stay in memory */ }
  }

  const isPinned = (id) => Boolean(state.pinned[id]);
  const isMuted = (id) => Boolean(state.muted[id]);

  return {
    isPinned,
    isMuted,
    togglePin(id) { if (state.pinned[id]) delete state.pinned[id]; else state.pinned[id] = 1; persist(); },
    toggleMute(id) { if (state.muted[id]) delete state.muted[id]; else state.muted[id] = 1; persist(); },
    hide(id, updatedAt = Date.now()) { state.hidden[id] = Number(updatedAt) || Date.now(); delete state.pinned[id]; persist(); },
    /** Sort pinned-first (then by recency), annotate pinned/muted, and drop a
     *  hidden conversation until it has a message newer than when it was hidden. */
    apply(conversations = []) {
      const rows = (Array.isArray(conversations) ? conversations : []).filter((c) => {
        const hiddenAt = state.hidden[c?.id];
        if (!hiddenAt) return true;
        if (Number(c?.updatedAt || 0) > hiddenAt) { delete state.hidden[c.id]; return true; }
        return false;
      });
      const decorated = rows.map((c) => ({ ...c, pinned: isPinned(c.id), muted: isMuted(c.id) }));
      return decorated.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    },
    /** Messages deleted locally (WeChat's 删除 removes them from YOUR view
     *  only — it is not a recall, so nobody else is affected). */
    isMessageHidden(messageId) { return Boolean(state.hiddenMessages[messageId]); },
    hideMessages(ids = []) {
      for (const id of ids) { if (id) state.hiddenMessages[String(id)] = 1; }
      persist();
    },
    applyMessages(messages = []) {
      const hidden = state.hiddenMessages;
      if (!Object.keys(hidden).length) return messages;
      return (Array.isArray(messages) ? messages : []).filter((m) => !hidden[String(m?.id || "")]);
    },
    reload() { state = load(); },
  };
}

function obj(value) { return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}; }
function safeStorage() { try { return window.localStorage; } catch { return null; } }
