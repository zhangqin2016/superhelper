#!/usr/bin/env node
// Active API-coverage probing for contract-less systems: verify JS-hinted GET
// endpoints read-only, record 403 as gated, never probe writes, and fill
// templated detail endpoints with a harvested id — all bounded + fail-open.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { probeApiCoverage, mergeProbe, fillTemplate, isTemplated } =
  require("../resources/skills-catalog/lily-web-system-learning/scripts/probe_api_coverage.cjs");

// helpers
assert.equal(isTemplated("/api/users/{id}"), true);
assert.equal(isTemplated("/api/users/:id"), true);
assert.equal(isTemplated("/api/users"), false);
assert.equal(fillTemplate("/api/users/{id}", "u1"), "/api/users/u1");
assert.equal(fillTemplate("/api/a/{x}/b/{y}", "1"), "", "refuses to fill multi-param templates");

const seen = [];
function mockFetch(url, opts) {
  seen.push({ url, method: opts?.method });
  const u = String(url);
  if (u.endsWith("/api/users")) return { ok: true, status: 200, contentType: "application/json", json: [{ id: "u1", name: "a" }, { id: "u2", name: "b" }] };
  if (u.endsWith("/api/users/u1")) return { ok: true, status: 200, contentType: "application/json", json: { id: "u1", name: "a", email: "e" } };
  if (u.endsWith("/api/settings")) return { ok: false, status: 403, contentType: "application/json", json: { error: "forbidden" } };
  if (u.endsWith("/api/secret")) return { ok: false, status: 404, json: null };
  if (u.endsWith("/api/page")) return { ok: true, status: 200, contentType: "text/html", json: null, text: "<html>" };
  return { ok: false, status: 500 };
}

const result = await probeApiCoverage({
  baseUrl: "https://app.test",
  allowedDomains: ["app.test"],
  apiHints: [
    { path: "/api/users", method: "GET" },
    { path: "/api/users/{id}", method: "GET" },
    { path: "/api/settings", method: "GET" },
    { path: "/api/secret", method: "GET" },
    { path: "/api/page", method: "GET" },
    { path: "/api/create", method: "POST" },
    { path: "/api/known", method: "GET" },
  ],
  existingContracts: [{ method: "GET", endpoint: "/api/known" }],
  storageState: null,
  delayMs: 0,
  fetchImpl: mockFetch,
});

const byPath = Object.fromEntries(result.contracts.map((c) => [c.endpoint, c]));

// verified read endpoint → real contract with a response schema
assert.equal(byPath["/api/users"].verified, true);
assert.equal(byPath["/api/users"].source, "probe");
assert.ok(byPath["/api/users"].responseSchema, "learned a response schema from the probe");

// parameter-space: templated detail endpoint filled with a harvested id, then
// relabeled back to the TEMPLATE (not the concrete filled url)
assert.ok(byPath["/api/users/{id}"], "templated detail endpoint covered");
assert.equal(byPath["/api/users/{id}"].verified, true);
assert.equal(result.stats.templatedVerified, 1);
assert.ok(!seen.some((s) => s.url.includes("{id}")), "probed the FILLED url, not the raw template");

// 403 → gated, recorded but not bypassed
assert.equal(byPath["/api/settings"].verified, false);
assert.equal(byPath["/api/settings"].access, "forbidden");
assert.equal(result.stats.gated, 1);

// write method → recorded UNVERIFIED and NEVER sent
assert.equal(byPath["/api/create"].verified, false);
assert.match(byPath["/api/create"].note, /NOT probed/);
assert.ok(!seen.some((s) => s.url.includes("/api/create")), "write endpoint must never be requested");
assert.ok(seen.every((s) => s.method === "GET"), "only GET is ever executed");

// stale (404) and non-JSON page → not added as contracts
assert.equal(byPath["/api/secret"], undefined, "404 hint dropped, not cited");
assert.equal(byPath["/api/page"], undefined, "non-JSON GET (a page) is not an API contract");
assert.ok(result.stats.stale >= 2);

// already-known endpoint skipped (not re-probed)
assert.equal(result.stats.skippedKnown, 1);
assert.ok(!seen.some((s) => s.url.endsWith("/api/known")), "known endpoint not re-probed");

// merge never overrides an existing contract
const merged = mergeProbe({ ok: true, contracts: [{ method: "GET", endpoint: "/api/users", source: "har" }] }, result, "https://app.test", ["app.test"]);
const usersEntries = merged.contracts.filter((c) => c.endpoint === "/api/users");
assert.equal(usersEntries.length, 1, "no duplicate; existing har contract preserved");
assert.equal(usersEntries[0].source, "har", "authoritative/earlier contract not overridden by probe");

// budget cap → warning, bounded probes
const capped = await probeApiCoverage({
  baseUrl: "https://app.test", allowedDomains: ["app.test"], delayMs: 0, maxProbes: 1, fetchImpl: mockFetch,
  apiHints: [{ path: "/api/a", method: "GET" }, { path: "/api/b", method: "GET" }, { path: "/api/c", method: "GET" }],
});
assert.ok(capped.stats.probed <= 1, "probe count respects the budget");
assert.ok(capped.warnings.some((w) => /budget/.test(w)), "reports partial coverage when budget hit");

console.log("web-system-probe-coverage: ok");
