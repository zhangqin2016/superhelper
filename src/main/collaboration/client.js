"use strict";

function clientError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

/**
 * Main-process-only collaboration HTTP client. The renderer receives decoded
 * domain values, never the short-lived bearer token or signed-device headers.
 */
function createCollaborationClient({ accountManager, signDeviceRequest, request } = {}) {
  if (!accountManager || typeof accountManager.accessTokenForService !== "function") throw new TypeError("An account token provider is required.");
  if (typeof signDeviceRequest !== "function" || typeof request !== "function") throw new TypeError("Signed device request dependencies are required.");
  async function invoke({ path, method = "POST", body = {}, deviceId }) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const account = await accountManager.accessTokenForService();
      if (!account?.ok || !account.accessToken) throw clientError(account?.error || "ACCOUNT_LOGIN_REQUIRED", "A collaboration account token is unavailable.");
      const deviceHeaders = await signDeviceRequest({ path, method, body, deviceId });
      const result = await request({ path, method, body, headers: { authorization: `Bearer ${account.accessToken}`, ...(deviceHeaders || {}) } });
      if (Number(result?.status) === 401 && attempt === 0) continue;
      if (!result?.ok) throw clientError(result?.json?.code || result?.code || "COLLAB_SERVICE_REQUEST_FAILED", "Collaboration request failed.");
      return result.json;
    }
    throw clientError("COLLAB_SERVICE_UNAUTHORIZED", "Collaboration authorization could not be refreshed.");
  }
  return {
    syncAfterCursor({ deviceId, afterCursor, limit } = {}) {
      return invoke({ path: "/api/collaboration/v1/sync", body: { deviceId, afterCursor, ...(limit == null ? {} : { limit }) }, deviceId });
    },
    acknowledgeCursor({ deviceId, cursor, bootstrapCompletionToken, clientCommandId } = {}) {
      const stableCommandId = clientCommandId || `ack:${String(deviceId)}:${Number(cursor)}:${bootstrapCompletionToken ? "bootstrap" : "incremental"}`;
      return invoke({ path: "/api/collaboration/v1/ack", body: { deviceId, cursor, clientCommandId: stableCommandId, ...(bootstrapCompletionToken ? { bootstrapCompletionToken } : {}) }, deviceId });
    },
    bootstrap({ deviceId } = {}) {
      return invoke({ path: "/api/collaboration/v1/bootstrap", body: { deviceId }, deviceId });
    },
    submitMessage(item) {
      return invoke({ path: "/api/collaboration/v1/messages", body: item, deviceId: item?.deviceId });
    },
    lookupCommandReceipt({ deviceId, clientCommandId } = {}) {
      return invoke({
        path: "/api/collaboration/v1/command-receipt",
        body: { deviceId, clientCommandId, commandType: "message.create" },
        deviceId,
      });
    },
    async listMessageHistory({ deviceId, conversationId, beforeSeq, limit = 200 } = {}) {
      const result = await invoke({
        path: "/api/collaboration/v1/messages",
        body: {
          action: "history", deviceId, conversationId,
          clientCommandId: `history:${String(conversationId || "")}:${Number(beforeSeq || 0)}`,
          ...(beforeSeq == null ? {} : { beforeSeq }), limit,
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
