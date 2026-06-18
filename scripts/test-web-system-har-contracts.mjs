#!/usr/bin/env node
/**
 * Learning APIs from real traffic (HAR) is the other half of "learn all APIs +
 * data structures": it covers contract-less systems and write-path endpoints
 * (POST/PUT/DELETE) that a published spec or read-only scan never reveals.
 * These pin the deterministic inference core: sample-merged JSON Schema
 * (required/enum/nullable), redaction, allowlist, and authoritative-wins merge.
 */
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const { inferSchema, harToContracts, mergeContracts } = require("../resources/skills-catalog/lily-web-system-learning/scripts/har_to_contracts.cjs");

try {
  // ===== sample-merged schema inference =====
  const schema = inferSchema([
    { id: 1, status: "open", note: "a" },
    { id: 2, status: "closed" }, // note absent → optional; status is a small set → enum
  ]);
  assert(schema.type === "object", "object schema");
  assert(schema.properties.id.type === "integer", "integer inferred");
  assert(schema.required.includes("id") && schema.required.includes("status"), "keys present in all samples are required");
  assert(!schema.required.includes("note"), "key missing from a sample is optional");
  assert(JSON.stringify(schema.properties.status.enum) === JSON.stringify(["open", "closed"]), "small value set → enum");

  const nullable = inferSchema([{ x: 1 }, null]);
  assert(nullable.nullable === true, "null among samples → nullable");

  const arr = inferSchema([[{ a: 1 }, { a: 2 }]]);
  assert(arr.type === "array" && arr.items.properties.a.type === "integer", "array element schema inferred");

  // ===== HAR → contracts (write path + redaction + allowlist) =====
  const har = { log: { entries: [
    { _resourceType: "fetch", request: { method: "GET", url: "https://erp.example.com/api/leaves?status=open", headers: [] },
      response: { status: 200, content: { mimeType: "application/json", text: JSON.stringify([{ id: 1, days: 2 }]) } } },
    { _resourceType: "fetch", request: { method: "POST", url: "https://erp.example.com/api/leaves", headers: [],
      postData: { mimeType: "application/json", text: JSON.stringify({ days: 3, reason: "x", password: "secret" }) } },
      response: { status: 201, content: { mimeType: "application/json", text: JSON.stringify({ id: 9, days: 3 }) } } },
    // off-allowlist must be ignored
    { _resourceType: "fetch", request: { method: "GET", url: "https://evil.com/api/x", headers: [] }, response: { status: 200, content: { mimeType: "application/json", text: "{}" } } },
    // static asset must be ignored
    { _resourceType: "image", request: { method: "GET", url: "https://erp.example.com/logo.png", headers: [] }, response: { status: 200, content: { mimeType: "image/png", text: "" } } },
  ] } };
  const result = harToContracts(har, "https://erp.example.com", ["example.com"]);
  assert(result.ok, "har parsed");
  assert(result.contracts.length === 2, `only allowlisted API traffic kept (got ${result.contracts.length})`);
  const post = result.contracts.find((c) => c.method === "POST");
  assert(post && post.risk === "submit", "write-path API learned from real traffic");
  assert(post.requestSchema.properties.days.type === "integer", "request schema inferred from POST body");
  assert(!post.requestFields.some((f) => f.name === "password"), "sensitive field redacted out of requestFields");
  assert(post.requestSchema.properties.password.description === "redacted-sensitive", "sensitive field redacted in schema");
  assert(post.responseSchema && post.responseSchema.properties.id, "response schema from 201 body");
  assert(post.observedStatuses.includes(201), "observed status recorded");
  assert(!result.contracts.some((c) => /evil\.com/.test(c.endpoint)), "off-allowlist endpoint dropped");
  assert(!result.contracts.some((c) => /logo\.png/.test(c.endpoint)), "static asset dropped");

  // ===== merge: authoritative (published) contracts are never overridden =====
  const existing = {
    ok: true, schemaVersion: 1, baseUrl: "https://erp.example.com", allowedDomains: ["example.com"],
    sources: [{ kind: "openapi3" }],
    contracts: [{ id: "list-leaves", source: "openapi", authoritative: true, method: "GET", endpoint: "https://erp.example.com/api/leaves", risk: "read", requestFields: [] }],
    dataSchemas: {}, coverage: {}, warnings: [],
  };
  const merged = mergeContracts(existing, result, "https://erp.example.com", ["example.com"]);
  const getContract = merged.contracts.filter((c) => c.method === "GET" && /\/api\/leaves$/.test(c.endpoint.replace(/\?.*$/, "")));
  assert(getContract.length === 1 && getContract[0].authoritative === true, "authoritative GET kept, HAR GET did not duplicate/override");
  assert(merged.contracts.some((c) => c.method === "POST" && c.source === "har"), "new HAR write endpoint merged in");
  assert(merged.coverage.harWriteEndpoints === 1, "coverage records HAR write endpoints");

  console.log("PASS: test-web-system-har-contracts (20 tests)");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
