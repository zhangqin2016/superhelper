"use strict";

const { projectAcceptedDirect } = require("./direct-projection");
const { projectAccessRevocation } = require("./access-revocation");
const { projectDirectoryEvent } = require("./directory-projection");

function syncError(message) {
  const error = new Error(message);
  error.code = "COLLAB_SYNC_PAGE_INVALID";
  return error;
}

function integer(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw syncError(`${label} is invalid`);
  return number;
}

function validatePage(page, cursor) {
  if (!page || (page.status && page.status !== "OK")) return { status: page?.status || "OK", events: [] };
  const fromCursor = integer(page.fromCursor, "from cursor");
  const toCursor = integer(page.toCursor, "to cursor");
  if (fromCursor !== cursor || toCursor < fromCursor) throw syncError("sync page does not match the local cursor");
  const events = Array.isArray(page.events) ? page.events : [];
  let expected = fromCursor + 1;
  for (const event of events) {
    if (integer(event?.cursor, "event cursor") !== expected || !String(event?.id || "") || !String(event?.type || "")) {
      throw syncError("sync page has a cursor gap or invalid event");
    }
    expected += 1;
  }
  if (toCursor !== expected - 1) throw syncError("sync page cursor does not match events");
  return { status: "OK", fromCursor, toCursor, events };
}

function createCollaborationSyncEngine({ store, projectEvent = (event) => {
  if (event?.payload?.failProjection) throw new Error("projection failed");
} } = {}) {
  if (!store || typeof store.getSyncState !== "function" || typeof store.applySyncPage !== "function") throw new TypeError("A collaboration store is required.");
  return {
    applyPage(page) {
      const local = store.getSyncState();
      const normalized = validatePage(page, local.cursor);
      if (normalized.status !== "OK") return { cursor: local.cursor, appliedEventIds: [] };
      const historyHydrationConversationIds = normalized.events
        .filter((event) => String(event?.type || "").startsWith("message."))
        .map((event) => event?.conversationId ?? event?.conversation_id)
        .filter(Boolean);
      return store.applySyncPage({ ...normalized, projectEvent(event) {
        projectAcceptedDirect(store, event);
        projectDirectoryEvent(store, event);
        projectAccessRevocation(store, event);
        projectEvent(event);
      }, historyHydrationConversationIds });
    },
    applyBootstrap(snapshot) {
      return store.replaceProjectionFromBootstrap(snapshot);
    },
  };
}

module.exports = { createCollaborationSyncEngine, validatePage };
