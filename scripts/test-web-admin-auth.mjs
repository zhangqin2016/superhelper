import assert from "node:assert/strict";
import { readAdminSummaryResponse } from "../web/lib/admin-auth-shared.mjs";

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

console.log("web admin auth response validation ok");
