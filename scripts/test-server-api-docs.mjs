#!/usr/bin/env node
// API documentation coverage gate: every server endpoint MUST appear in the
// generated OpenAPI spec with a human summary and at least one tag. This is the
// machine-enforced half of docs/api-documentation-standard.md — a new route with
// no `schema.summary`/`schema.tags` fails here, so the Swagger docs can never
// silently fall behind the API. Runs without a database (buildDocApp).
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://unused:unused@localhost:5432/unused";

const { buildDocApp } = await import("../server/src/app.js");
const { OPENAPI_TAGS } = await import("../server/src/openapi.js");
const app = await buildDocApp();
const spec = app.swagger();
await app.close();

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const ALLOWED_TAGS = new Set(OPENAPI_TAGS.map((tag) => tag.name));
const paths = spec.paths || {};
const missing = [];
const invalidTags = [];
let documented = 0;

for (const [routePath, methods] of Object.entries(paths)) {
  if (routePath === "/docs" || routePath.startsWith("/docs/")) continue; // Swagger UI itself
  for (const [method, op] of Object.entries(methods)) {
    if (!HTTP_METHODS.has(method)) continue;
    const problems = [];
    if (!op || typeof op.summary !== "string" || !op.summary.trim()) problems.push("summary");
    if (!Array.isArray(op?.tags) || op.tags.length === 0) problems.push("tags");
    for (const tag of op?.tags || []) {
      if (!ALLOWED_TAGS.has(tag)) invalidTags.push(`${method.toUpperCase()} ${routePath} — invalid tag ${tag}`);
    }
    if (problems.length) missing.push(`${method.toUpperCase()} ${routePath} — missing ${problems.join(" + ")}`);
    else documented += 1;
  }
}

assert.equal(
  missing.length,
  0,
  `every endpoint must have schema.summary + schema.tags (see docs/api-documentation-standard.md). Undocumented:\n  ${missing.join("\n  ")}`,
);
assert.equal(
  invalidTags.length,
  0,
  `every endpoint tag must be declared in OPENAPI_TAGS. Invalid:\n  ${invalidTags.join("\n  ")}`,
);
assert.ok(documented >= 60, `expected the full API surface to be documented, only saw ${documented} operations`);

console.log(`server-api-docs: ok (${documented} endpoints documented)`);
