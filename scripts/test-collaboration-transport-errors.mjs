import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createCollaborationClient } = require("../src/main/collaboration/client.js");
const responses = [
  [{ ok: false, status: 0, code: "SERVICE_REQUEST_FAILED" }, "COLLAB_RESPONSE_UNKNOWN"],
  [{ ok: false, status: 504 }, "COLLAB_RESPONSE_UNKNOWN"],
  [{ ok: false, status: 429 }, "COLLAB_RATE_LIMITED"],
  [{ ok: false, status: 403, code: "COLLAB_AUTHORIZATION_DENIED" }, "COLLAB_AUTHORIZATION_DENIED"],
];
for (const [response, expected] of responses) {
  const client = createCollaborationClient({ accountManager: { accessTokenForService: async () => ({ ok: true, accessToken: "t" }) }, signDeviceRequest: async () => ({}), request: async () => response });
  await assert.rejects(() => client.submitMessage({ action: "send", deviceId: "d", conversationId: "c", clientCommandId: "same", bodyText: "x" }),
    (error) => error.code === expected, `HTTP ${response.status} must not misreport an uncertain commit as a permanent failure`);
}
const forced = [];
const client = createCollaborationClient({
  accountManager: { accessTokenForService: async (options) => { forced.push(options?.forceRefresh === true); return { ok: true, accessToken: "t" }; } },
  signDeviceRequest: async () => ({}), request: async () => forced.length === 1 ? { ok: false, status: 401 } : { ok: true, json: { ok: true } },
});
await client.bootstrap({ deviceId: "d" });
assert.deepEqual(forced, [false, true], "401 must request a genuinely fresh token, not reuse the still-unexpired cached token");
let activeAccount = "alice", requests = 0;
const accountBound = createCollaborationClient({
  expectedAccountId: "alice",
  accountManager: {
    accountStatus: () => ({ loggedIn: true, user: { id: activeAccount } }),
    accessTokenForService: async () => { activeAccount = "bob"; return { ok: true, accessToken: "bob-token" }; },
  },
  signDeviceRequest: async () => ({}), request: async () => { requests += 1; return { ok: true, json: {} }; },
});
await assert.rejects(() => accountBound.submitMessage({ action: "send", clientCommandId: "alice-intent" }), (error) => error.code === "COLLAB_ACCOUNT_CHANGED");
assert.equal(requests, 0, "an old account's queued intent must not borrow the newly logged-in account's bearer token");
console.log("collaboration transport failure classification passed");
