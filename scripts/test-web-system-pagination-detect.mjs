#!/usr/bin/env node
/**
 * Learning-side pagination detection (web-system-learning #2, deterministic layer):
 * har_to_contracts infers a `pagination` HINT on a contract from the request's
 * query keys + the response shape. The hint lets the planner fill op.pagination
 * without guessing the param/itemsPath. WHY a hint (not auto-loop): blindly
 * paginating every call would over-fetch a single-page read — so detection only
 * records the shape; the planner decides when "all/export" intent applies.
 * Must NOT false-positive on a plain list (bare array) response.
 */
import assert from "node:assert/strict";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const { harToContracts } = require("../resources/skills-catalog/lily-web-system-learning/scripts/har_to_contracts.cjs");

const entry = (url, body) => ({
  _resourceType: "fetch",
  request: { method: "GET", url, headers: [] },
  response: { status: 200, content: { mimeType: "application/json", text: JSON.stringify(body) } },
});
const run = (url, body) => {
  const r = harToContracts({ log: { entries: [entry(url, body)] } }, "https://erp.example.com", ["example.com"]);
  return r.contracts[0];
};

// cursor: ?cursor=... + response { data:[...], nextCursor }
{
  const c = run("https://erp.example.com/api/orders?cursor=abc", { data: [{ id: 1 }], nextCursor: "def" });
  assert.ok(c.pagination, "cursor pagination detected");
  assert.equal(c.pagination.mode, "cursor");
  assert.equal(c.pagination.param, "cursor");
  assert.equal(c.pagination.itemsPath, "data");
  assert.equal(c.pagination.nextPath, "nextCursor");
}

// page: ?page=2 + response { rows:[...], page, total }
{
  const c = run("https://erp.example.com/api/items?page=2&pageSize=50", { rows: [{ id: 1 }], page: 2, total: 120 });
  assert.equal(c.pagination.mode, "page");
  assert.equal(c.pagination.param, "page");
  assert.equal(c.pagination.itemsPath, "rows");
}

// offset: ?offset=20 + response { results:[...] }
{
  const c = run("https://erp.example.com/api/log?offset=20", { results: [{ id: 1 }] });
  assert.equal(c.pagination.mode, "offset");
  assert.equal(c.pagination.param, "offset");
  assert.equal(c.pagination.itemsPath, "results");
}

// NEGATIVE: a bare-array response is a plain list, not paginated -> no false positive.
{
  const c = run("https://erp.example.com/api/flat", [{ id: 1 }, { id: 2 }]);
  assert.ok(!c.pagination, "no pagination hint on a bare-array response");
}

// NEGATIVE: object response with an items array but NO paging param/cursor -> unsure -> none.
{
  const c = run("https://erp.example.com/api/all", { data: [{ id: 1 }] });
  assert.ok(!c.pagination, "no hint when no paging mechanism is recognized");
}

console.log("web-system-pagination-detect: ok");
