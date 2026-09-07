"use strict";
const { createObjectClient } = require("./object-client");
const { presenceRequest } = require("./online-status");
const { randomUUID } = require("node:crypto");

function clientError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

/**
 * Main-process-only collaboration HTTP client. The renderer receives decoded
 * domain values, never the short-lived bearer token or signed-device headers.
 */
function createCollaborationClient({ accountManager, signDeviceRequest, request, expectedAccountId = "", getServiceBaseUrl, WebSocketCtor = globalThis.WebSocket } = {}) {
  if (!accountManager || typeof accountManager.accessTokenForService !== "function") throw new TypeError("An account token provider is required.");
  if (typeof signDeviceRequest !== "function" || typeof request !== "function") throw new TypeError("Signed device request dependencies are required.");
  let stopped = false;
  function assertAccountBinding() {
    if (stopped) throw clientError("COLLABORATION_STOPPED");
    if (!expectedAccountId) return;
    const status = accountManager.accountStatus?.();
    if (!status?.loggedIn || String(status?.user?.id || "") !== String(expectedAccountId)) throw clientError("COLLAB_ACCOUNT_CHANGED");
  }
  async function invoke({ path, method = "POST", body = {}, deviceId }) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assertAccountBinding();
      const account = await accountManager.accessTokenForService({ forceRefresh: attempt > 0 });
      assertAccountBinding();
      if (!account?.ok || !account.accessToken) throw clientError(account?.transient ? "COLLAB_NETWORK_UNAVAILABLE" : account?.error || "ACCOUNT_LOGIN_REQUIRED", "A collaboration account token is unavailable.");
      const deviceHeaders = await signDeviceRequest({ path, method, body, deviceId });
      assertAccountBinding();
      let result;
      try {
        result = await request({ path, method, body, headers: { authorization: `Bearer ${account.accessToken}`, ...(deviceHeaders || {}) } });
      } catch {
        // Once handed to transport there is no proof that a command did not
        // commit. Do not mistake a reset/timeout for a permanent rejection.
        throw clientError("COLLAB_RESPONSE_UNKNOWN");
      }
      assertAccountBinding();
      if (Number(result?.status) === 401 && attempt === 0) continue;
      if (!result?.ok) {
        const status = Number(result?.status || 0);
        const code = status === 0 || status === 408 || status >= 500 ? "COLLAB_RESPONSE_UNKNOWN"
          : status === 429 ? "COLLAB_RATE_LIMITED"
            : result?.json?.code || result?.code || "COLLAB_SERVICE_REQUEST_FAILED";
        const error = clientError(code, "Collaboration request failed.");
        error.retryable = result?.json?.retryable === true || ["COLLAB_RESPONSE_UNKNOWN", "COLLAB_RATE_LIMITED"].includes(code);
        throw error;
      }
      return result.json;
    }
    throw clientError("COLLAB_SERVICE_UNAUTHORIZED", "Collaboration authorization could not be refreshed.");
  }
  return {
    ...(typeof getServiceBaseUrl === "function" ? { async createRealtimeSocket({deviceId}) {
      const base = getServiceBaseUrl();
      const url = new URL("/api/collaboration/v1/realtime", base);
      if (!["http:","https:"].includes(url.protocol) || typeof WebSocketCtor !== "function") throw clientError("COLLAB_REALTIME_UNAVAILABLE");
      const value = await invoke({path:"/api/collaboration/v1/ws-ticket",body:{deviceId,clientCommandId:randomUUID()},deviceId});
      assertAccountBinding();
      if (base !== getServiceBaseUrl() || typeof value?.ticket !== "string" || !value.ticket || value.ticket.length > 2048) throw clientError("COLLAB_REALTIME_UNAVAILABLE");
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.searchParams.set("ticket",value.ticket);
      return new WebSocketCtor(url.href);
    } } : {}),
    objects: createObjectClient({ invoke }),
    // This fences local continuations, not a remote command that may already
    // have committed. The outbox retains the original durable recovery key.
    stop() { stopped = true; },
    syncAfterCursor({ deviceId, afterCursor, limit } = {}) {
      return invoke({ path: "/api/collaboration/v1/sync", body: { deviceId, afterCursor, ...(limit == null ? {} : { limit }) }, deviceId });
    },
    acknowledgeCursor({ deviceId, cursor, bootstrapCompletionToken, clientCommandId } = {}) {
      const stableCommandId = clientCommandId || `ack:${String(deviceId)}:${Number(cursor)}:${bootstrapCompletionToken ? "bootstrap" : "incremental"}`;
      return invoke({ path: "/api/collaboration/v1/ack", body: { deviceId, cursor, clientCommandId: stableCommandId, ...(bootstrapCompletionToken ? { bootstrapCompletionToken } : {}) }, deviceId });
    },
    getEnterpriseDirectory({ deviceId } = {}) {
      return invoke({ path: "/api/collaboration/v1/enterprise-directory", body: { deviceId }, deviceId });
    },
    getPresence({ deviceId, userIds } = {}) {
      if (!presenceRequest({ userIds })) throw clientError("COLLABORATION_INVALID_INPUT");
      return invoke({ path: "/api/collaboration/v1/presence", body: { deviceId, userIds }, deviceId });
    },
    bootstrap({ deviceId } = {}) {
      return invoke({ path: "/api/collaboration/v1/bootstrap", body: { deviceId }, deviceId });
    },
    submitMessage(item) {
      return invoke({ path: "/api/collaboration/v1/messages", body: item, deviceId: item?.deviceId });
    },
    submitFriend(item) {
      return invoke({ path: "/api/collaboration/v1/friends", body: item, deviceId: item?.deviceId });
    },
    /** A read, not a queued command: looking someone up must never leave an
     *  outbox row or a receipt behind. Failure is the caller's to interpret. */
    async lookupFriend({ deviceId, lilyId } = {}) {
      const response = await invoke({ path: "/api/collaboration/v1/friends/lookup", body: { deviceId, lilyId }, deviceId });
      return response?.result;
    },
    submitConversation(item) {
      return invoke({ path: "/api/collaboration/v1/conversations", body: item, deviceId: item?.deviceId });
    },
    submitTask(item) {
      return invoke({ path: "/api/collaboration/v1/tasks", body: item, deviceId: item?.deviceId });
    },
    async getTask({ deviceId, taskId }) {
      const response = await invoke({ path: "/api/collaboration/v1/tasks/get", body: { deviceId, taskId }, deviceId });
      return response?.result;
    },
    async listTasks({ deviceId, conversationId }) {
      const response = await invoke({ path: "/api/collaboration/v1/tasks/list", body: { deviceId, conversationId }, deviceId });
      return response?.result;
    },
    async getConversationProjection({ deviceId, conversationId }) {
      const response = await invoke({ path: "/api/collaboration/v1/conversations/get", body: { deviceId, conversationId }, deviceId });
      return response?.result;
    },
    lookupCommandReceipt({ deviceId, clientCommandId, commandType = "message.create", conversationId, messageId, expectedRevision } = {}) {
      return invoke({
        path: "/api/collaboration/v1/command-receipt",
        body: { deviceId, clientCommandId, commandType, expectedConversationId: conversationId,
          ...(messageId == null ? {} : { expectedMessageId: messageId }),
          ...(expectedRevision == null ? {} : { expectedRevision }), },
        deviceId,
      });
    },
    async listMessageHistory({ deviceId, conversationId, beforeSeq, messageIds, limit = 200 } = {}) {
      const result = await invoke({
        path: "/api/collaboration/v1/messages",
        body: {
          action: "history", deviceId, conversationId,
          clientCommandId: `history:${String(conversationId || "")}:${Number(beforeSeq || 0)}`,
          ...(beforeSeq == null ? {} : { beforeSeq }), ...(messageIds == null ? {} : { messageIds }), limit,
        },
        deviceId,
      });
      return result?.result || result;
    },
    async syncAndAcknowledge({ deviceId, afterCursor, syncEngine, limit, onFullResync, onIncrementalPage } = {}) {
      if (!syncEngine) throw new TypeError("A sync engine is required.");
      const page = await this.syncAfterCursor({ deviceId, afterCursor, limit });
      if (page?.status === "FULL_RESYNC_REQUIRED") {
        const snapshot = await this.bootstrap({ deviceId });
        if (typeof onFullResync === "function") {
          return onFullResync({
            snapshot,
            acknowledge: () => this.acknowledgeCursor({ deviceId, cursor: snapshot.watermark, bootstrapCompletionToken: snapshot.bootstrapCompletionToken }),
          });
        }
        // A bare client has no authority to claim a full-resync is complete:
        // it cannot safely decrypt/hydrate the server history projection. The
        // service callback owns local replacement, authorized history fetch,
        // and only then the server-issued completion ACK.
        return { status: "FULL_RESYNC_REQUIRED", snapshot, requiresHydration: true };
      }
      if (typeof syncEngine.applyPage !== "function") throw new TypeError("A page-capable sync engine is required.");
      if (typeof onIncrementalPage === "function") {
        return onIncrementalPage({
          page,
          acknowledge: () => this.acknowledgeCursor({ deviceId, cursor: page.toCursor }),
        });
      }
      const applied = syncEngine.applyPage(page); // SQLite commit completes before network ACK begins.
      await this.acknowledgeCursor({ deviceId, cursor: applied.cursor });
      return { ...applied, events: Array.isArray(page.events) ? page.events : [] };
    },
  };
}

module.exports = { createCollaborationClient, clientError };
