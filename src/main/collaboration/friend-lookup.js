"use strict";

/**
 * Looking a Lily ID up before sending a friend request.
 *
 * Why this is not a queued command: it persists nothing. Routing it through the
 * outbox would leave a retryable row and a receipt behind for what is a read,
 * and a failed lookup needs no recovery — the person just types again.
 *
 * Why the result carries no reason: the server answers with ONE failure for
 * "no such id", "that is you", "hidden discoverability" and "either side has
 * blocked the other". That is deliberate — distinguishing them would let anyone
 * probe which Lily IDs exist — so this passes the single failure through and
 * never guesses which case it was. Callers must not invent an explanation.
 */

const { createEnterpriseDirectoryReader } = require("./enterprise-directory");

const LILY_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;

/** Same shape the server enforces, applied before spending a rate-limit slot. */
function normalizeLilyId(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return LILY_ID.test(normalized) ? normalized : "";
}

function createFriendLookup({ client, deviceId, assertActive = () => {}, isStopped = () => false, stoppedResult, unavailableService }) {
  return async function lookupFriend({ lilyId } = {}) {
    if (isStopped()) return stoppedResult();
    const normalized = normalizeLilyId(lilyId);
    if (!normalized) return { ok: false, code: "COLLABORATION_INVALID_INPUT", retryable: false };
    if (!client || !deviceId || typeof client.lookupFriend !== "function") return unavailableService();
    try {
      const profile = await client.lookupFriend({ deviceId, lilyId: normalized });
      // An account swap mid-flight must not return the previous account's answer.
      assertActive();
      if (!profile?.userId) return { ok: false, code: "COLLAB_TARGET_UNAVAILABLE", retryable: false };
      return { ok: true, profile };
    } catch (error) {
      if (["COLLABORATION_STOPPED", "COLLAB_ACCOUNT_CHANGED"].includes(error?.code)) throw error;
      return { ok: false, code: String(error?.code || "COLLAB_TARGET_UNAVAILABLE"), retryable: error?.retryable === true };
    }
  };
}

/** The two local directory reads, kept here with the lookup because all three
 *  answer the same question — "who can I talk to?" — and service.js is at its
 *  line ceiling. */
function createDirectoryReads({ store, socialDirectory, directoryView, client, deviceId, assertActive, isStopped = () => false, stoppedResult, unavailableService }) {
  const readEnterprise = createEnterpriseDirectoryReader({ client, deviceId, assertActive });
  return {
    getDirectory() {
      if (isStopped()) return stoppedResult();
      if (typeof store.getDirectory !== "function") return unavailableService();
      const local = directoryView(store.getDirectory());
      if (!client?.getEnterpriseDirectory) return { ok: true, ...local };
      return readEnterprise(local).then(value => ({ ok: true, ...directoryView(value) }));
    },
    list() {
      if (isStopped()) return stoppedResult();
      if (typeof store.listConversations !== "function") return unavailableService();
      return { ok: true, conversations: socialDirectory.visibleConversations(store) };
    },
  };
}

module.exports = { createFriendLookup, createDirectoryReads, normalizeLilyId, LILY_ID };
