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
    async syncAndAcknowledge({ deviceId, afterCursor, syncEngine, limit } = {}) {
      if (!syncEngine) throw new TypeError("A sync engine is required.");
      const page = await this.syncAfterCursor({ deviceId, afterCursor, limit });
      if (page?.status === "FULL_RESYNC_REQUIRED") {
        if (typeof syncEngine.applyBootstrap !== "function") throw new TypeError("A bootstrap-capable sync engine is required.");
        const snapshot = await this.bootstrap({ deviceId });
        const applied = syncEngine.applyBootstrap(snapshot); // must commit before completion ACK
        await this.acknowledgeCursor({ deviceId, cursor: applied.cursor, bootstrapCompletionToken: snapshot.bootstrapCompletionToken });
        return applied;
      }
      if (typeof syncEngine.applyPage !== "function") throw new TypeError("A page-capable sync engine is required.");
      const applied = syncEngine.applyPage(page); // SQLite commit completes before network ACK begins.
      await this.acknowledgeCursor({ deviceId, cursor: applied.cursor });
      return applied;
    },
  };
}

module.exports = { createCollaborationClient, clientError };
