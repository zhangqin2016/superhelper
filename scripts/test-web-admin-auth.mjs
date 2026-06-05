import assert from "node:assert/strict";
import fs from "node:fs";
import { adminCredentialHeaders, readAdminSummaryResponse } from "../web/lib/admin-auth-shared.mjs";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

const validSummary = {
  licenses: 0,
  activeLicenses: 0,
  devices: 0,
  activeDevicesToday: 0,
  todayMessages: 0,
  todayTokens: 0,
  models: [],
  trend: [],
};

assert.deepEqual(await readAdminSummaryResponse(jsonResponse(validSummary)), validSummary);
assert.equal(await readAdminSummaryResponse(new Response("<html>Open WebUI</html>", {
  status: 200,
  headers: { "content-type": "text/html" },
})), null);
assert.equal(await readAdminSummaryResponse(jsonResponse({ ok: true })), null);
assert.equal(await readAdminSummaryResponse(jsonResponse(validSummary, { status: 401 })), null);

process.env.ADMIN_TOKEN = "server-token-must-not-authenticate-web";
assert.equal(adminCredentialHeaders(), null);
assert.deepEqual(adminCredentialHeaders({ token: "cookie-token" }), {
  Authorization: "Bearer cookie-token",
});
assert.deepEqual(adminCredentialHeaders({ session: "session value" }), {
  Cookie: "lily_admin_session=session%20value",
});

const proxySource = fs.readFileSync(new URL("../web/proxy.js", import.meta.url), "utf8");
const apiSource = fs.readFileSync(new URL("../web/lib/api.js", import.meta.url), "utf8");
assert.equal(proxySource.includes("process.env.ADMIN_TOKEN"), false);
assert.equal(apiSource.includes("process.env.ADMIN_TOKEN"), false);

console.log("web admin auth response validation ok");
