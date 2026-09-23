import assert from "node:assert/strict";
import fs from "node:fs";
import { ADMIN_SESSION_PATH, adminCredentialHeaders, createAdminSessionVerdicts, isPrefetchRequest, readAdminSessionResponse, readAdminSummaryResponse } from "../web/lib/admin-auth-shared.mjs";

// Polyfill Response for Node < 18
if (typeof globalThis.Response === "undefined") {
  globalThis.Response = class Response {
    constructor(body, init = {}) {
      this._body = body;
      this.status = init.status || 200;
      this.headers = new Map(Object.entries(init.headers || {}));
      this.ok = this.status >= 200 && this.status < 300;
    }
    async json() { return JSON.parse(this._body); }
    async text() { return String(this._body); }
  };
}

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

// The console's session check is the light endpoint, recognised by its shape;
// another service on the same address still never passes.
const session = { ok: true, service: "lily-admin", role: "admin" };
assert.deepEqual(await readAdminSessionResponse(jsonResponse(session)), session);
assert.equal(await readAdminSessionResponse(jsonResponse({ ok: true })), null, "a bare ok is not this API");
assert.equal(await readAdminSessionResponse(new Response("<html>Open WebUI</html>", { status: 200, headers: { "content-type": "text/html" } })), null);
assert.equal(await readAdminSessionResponse(jsonResponse(session, { status: 401 })), null);
process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/lily_web_admin_auth_test";
const { ADMIN_SESSION_SERVICE } = await import("../server/src/routes/admin.js");
assert.equal(ADMIN_SESSION_SERVICE, session.service, "the server answers the shape the console expects");

// A hundred row links are a hundred router prefetches, which the proxy cannot
// tell from navigations (Next strips its flight headers first). A confirmed
// credential is remembered briefly, so they cost one check, not a hundred.
const h = (entries) => new Headers(entries);
assert.equal(isPrefetchRequest(h({ "sec-purpose": "prefetch;prerender" })), true);
assert.equal(isPrefetchRequest(h({})), false);
{
  let clock = 1_000;
  const verdicts = createAdminSessionVerdicts({ ttlMs: 30_000, now: () => clock });
  assert.equal(await verdicts.confirmed("t:abc"), false, "an unseen credential is checked");
  await verdicts.remember("t:abc");
  assert.equal(await verdicts.confirmed("t:abc"), true, "a confirmed one is not re-checked");
  assert.equal(await verdicts.confirmed("t:other"), false, "and confirms nothing else");
  clock += 30_001;
  assert.equal(await verdicts.confirmed("t:abc"), false, "the verdict expires");
  await verdicts.remember("t:abc");
  await verdicts.forget("t:abc");
  assert.equal(await verdicts.confirmed("t:abc"), false, "a 401 forgets it at once");
  for (let i = 0; i < 200; i += 1) await verdicts.remember(`t:${i}`);
  assert.equal(await verdicts.confirmed("t:199"), true, "the store is bounded and keeps the newest");
}

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
assert.ok(!proxySource.includes("/api/admin/summary"), "the per-request session check does not run the dashboard aggregate");
assert.ok(proxySource.includes("${ADMIN_SESSION_PATH}") && ADMIN_SESSION_PATH === "/api/admin/session");
assert.ok(proxySource.indexOf("adminSessionVerdicts.confirmed(credential)") < proxySource.indexOf("await validateAdminSession(headers)"), "a remembered verdict is consulted before any API call");
assert.match(proxySource, /if \(result\.valid\) await adminSessionVerdicts\.remember\(credential\)/, "only a positive verdict is kept");

console.log("web admin auth response validation ok");
