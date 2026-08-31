"use strict";

const invalid = () => Object.assign(new Error("COLLAB_OBJECT_METADATA_INVALID"), { code: "COLLAB_OBJECT_METADATA_INVALID" });
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x20\x7f]/.test(value);

/** Uses the containing client's signed, refreshed, account-fenced invoke.
 * Capabilities remain main-only; never expose this object through preload.
 */
function createObjectClient({ invoke }) {
  function call(method, fields = []) {
    return async (input = {}) => {
      const allowed = new Set(["deviceId", "clientCommandId", ...(method === "init" ? [] : ["objectId"]), ...fields]);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))
        || !id(input.deviceId) || !id(input.clientCommandId)) throw invalid();
      if (method !== "init" && (typeof input.objectId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(input.objectId))) throw invalid();
      const body = { deviceId: input.deviceId, clientCommandId: input.clientCommandId };
      for (const field of fields) if (input[field] !== undefined) body[field] = input[field];
      const suffix = method === "init" ? "init" : `${input.objectId}/${method === "downloadTicket" ? "download-ticket" : method}`;
      const response = await invoke({ path: `/api/collaboration/v1/objects/${suffix}`, body, deviceId: input.deviceId });
      if (!response?.result || typeof response.result !== "object" || Array.isArray(response.result)) throw invalid();
      return response.result;
    };
  }
  return Object.freeze({
    init: call("init", ["conversationId", "purpose", "dek", "ciphertextSize", "ciphertextSha256", "mimeType", "originalName", "expiresAt"]),
    status: call("status"), complete: call("complete", ["etag", "ciphertextSize", "ciphertextSha256"]),
    abort: call("abort"), revoke: call("revoke"), downloadTicket: call("downloadTicket"),
  });
}

module.exports = { createObjectClient };
