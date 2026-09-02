"use strict";

/**
 * Who is typing, right now, per conversation.
 *
 * The realtime gateway relays `typing`/`presence` frames between conversation
 * members with a server-stamped `expiresAt` (TTL capped at 30s). Those frames
 * are pure hints: they are never persisted, never authoritative, and a missed
 * one must degrade to "nobody is typing" rather than to a stuck indicator.
 *
 * So this is deliberately a self-expiring in-memory registry with no timers —
 * entries are pruned on every read. No timer means no leak and no wake-up cost
 * when the panel is closed, and a peer that goes silent (crash, network drop)
 * stops showing as typing on its own.
 *
 * Everything is bounded: a hostile or buggy peer cannot grow this without
 * limit by naming new conversations or users.
 */

const MAX_CONVERSATIONS = 64;
const MAX_USERS_PER_CONVERSATION = 16;
const MAX_TTL_MS = 30_000;

function createEphemeralPresence({ now = () => Date.now() } = {}) {
  /** @type {Map<string, Map<string, number>>} conversationId -> userId -> expiresAt */
  const typing = new Map();

  const pruneConversation = (conversationId, at) => {
    const users = typing.get(conversationId);
    if (!users) return null;
    for (const [userId, expiresAt] of users) if (expiresAt <= at) users.delete(userId);
    if (users.size === 0) { typing.delete(conversationId); return null; }
    return users;
  };

  return {
    /**
     * Record an inbound ephemeral frame. Returns true when the live set changed,
     * so the caller only notifies the UI on a real transition.
     */
    note(frame) {
      // A relayed frame is untrusted input, so null/garbage must return false
      // rather than throw. The caller's try/catch is a backstop, not the
      // contract.
      if (!frame || typeof frame !== "object") return false;
      const type = String(frame.type || "");
      if (type !== "typing") return false;
      const conversationId = String(frame.conversationId || "").trim();
      const userId = String(frame.userId || "").trim();
      if (!conversationId || !userId) return false;
      const at = now();
      // Trust the server's stamp when present, but never beyond the cap; a
      // missing/!unparseable stamp falls back to the frame's own bounded ttl.
      const stamped = Date.parse(String(frame.expiresAt || ""));
      const ttl = Number(frame.ttlMs);
      const expiresAt = Number.isFinite(stamped) && stamped > at
        ? Math.min(stamped, at + MAX_TTL_MS)
        : at + Math.min(Math.max(Number.isFinite(ttl) ? ttl : 0, 1_000), MAX_TTL_MS);
      let users = pruneConversation(conversationId, at);
      if (!users) {
        if (typing.size >= MAX_CONVERSATIONS) {
          // Drop the conversation whose newest entry is oldest, so an active
          // chat is never evicted by a flood of stale ones.
          let oldestKey = null;
          let oldestAt = Infinity;
          for (const [key, entries] of typing) {
            const newest = Math.max(...entries.values());
            if (newest < oldestAt) { oldestAt = newest; oldestKey = key; }
          }
          if (oldestKey) typing.delete(oldestKey);
        }
        users = new Map();
        typing.set(conversationId, users);
      }
      const had = users.has(userId);
      if (!had && users.size >= MAX_USERS_PER_CONVERSATION) return false;
      users.set(userId, expiresAt);
      return !had;
    },

    /** Live typists in one conversation, expired entries pruned. */
    typingUserIds(conversationId) {
      const users = pruneConversation(String(conversationId || "").trim(), now());
      return users ? [...users.keys()] : [];
    },

    /** `{ conversationId: [userId, …] }` for the state projection. */
    snapshot() {
      const at = now();
      const out = {};
      for (const conversationId of [...typing.keys()]) {
        const users = pruneConversation(conversationId, at);
        if (users) out[conversationId] = [...users.keys()];
      }
      return out;
    },

    /** A member who left, a revoked scope, or a stopped service clears state. */
    forget(conversationId) {
      if (conversationId == null) { typing.clear(); return; }
      typing.delete(String(conversationId).trim());
    },
  };
}

/**
 * The "I am typing" command.
 *
 * Best effort by contract: this is a hint channel, so a closed socket or a
 * stopped service is a `sent: false`, never an error the composer has to
 * handle. The conversation is checked first so a typing frame can never be
 * used to probe for conversations the account cannot see.
 */
function createTypingCommand({ store, getRealtime, isStopped, stoppedResult, ttlMs = 6_000 } = {}) {
  return function typing({ conversationId } = {}) {
    if (isStopped()) return stoppedResult();
    if (!store.getConversation?.({ conversationId })) return { ok: false, code: "COLLABORATION_NOT_FOUND" };
    const sent = getRealtime()?.sendEphemeral?.({ type: "typing", conversationId, ttlMs }) === true;
    return { ok: true, sent };
  };
}

module.exports = {
  MAX_CONVERSATIONS, MAX_TTL_MS, MAX_USERS_PER_CONVERSATION,
  createEphemeralPresence, createTypingCommand,
};
