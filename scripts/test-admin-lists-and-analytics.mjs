#!/usr/bin/env node
// Two things an operator could not do. Every admin list was a bare `.limit(300)`
// with no cursor and no total, so past 300 rows the page showed a truncated list
// and said nothing — 300 and 30,000 looked identical and the rest was
// unreachable. And the usage page showed sums, which cannot answer the question
// people actually ask: production carries 999M tokens in 30 days where ONE
// device is 26% of it, and no sum can say that.
// [gate: admin-lists-and-analytics]
// Run: node scripts/test-admin-lists-and-analytics.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/lily_lists_test";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

const paging = await import("../server/src/services/admin-pagination.js");

await check("a cursor is opaque, survives a round trip, and never becomes an error", () => {
  const cursor = paging.encodeCursor(new Date("2026-09-23T10:00:00Z"), "row_7");
  assert.deepEqual(paging.decodeCursor(cursor), { sortValue: "2026-09-23T10:00:00.000Z", id: "row_7" });
  // A client must not be able to hand-build one, and a broken one reads the
  // first page rather than failing the console.
  assert.ok(!cursor.includes("row_7"), "the cursor is opaque");
  for (const bad of ["", "garbage", "!!!", Buffer.from("[]").toString("base64url")]) {
    assert.equal(paging.decodeCursor(bad), null, `${bad || "(empty)"} reads the first page`);
  }
});

await check("a page is bounded, and asks for one row more to know whether there is a next", async () => {
  const captured = {};
  const builder = {
    where() { captured.filtered = true; return builder; },
    orderBy() { return builder; },
    limit(n) { captured.limit = n; return builder; },
    execute: async () => Array.from({ length: captured.limit }, (_, i) => ({ id: `row_${100 - i}`, created_at: `2026-09-${20 - i}` })),
  };
  const page = await paging.pageOf({ query: () => builder, sortColumn: "created_at", limit: 5 });
  assert.equal(captured.limit, 6, "one more than the page, so nextCursor is knowable without a second query");
  assert.equal(page.items.length, 5);
  assert.ok(page.nextCursor, "and there is a next page");
  assert.equal(page.pageSize, 5);
  const capped = await paging.pageOf({ query: () => builder, sortColumn: "created_at", limit: 9999 });
  assert.equal(capped.pageSize, paging.MAX_PAGE_SIZE, "a caller cannot ask for the whole table");
});

await check("every admin list answers with a cursor and a total — none truncates silently", () => {
  const dir = path.join(ROOT, "server/src/routes/admin");
  const offenders = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    // A hard limit with no paging contract in the same file is the old shape.
    const hardLimits = (src.match(/\.limit\((?:1000|300|200)\)/g) || []).length;
    if (hardLimits && !/listPage\(/.test(src)) offenders.push(`${file}: ${hardLimits} hard limit(s), no paging`);
  }
  assert.deepEqual(offenders, [], `these lists still truncate silently:\n${offenders.join("\n")}`);
  for (const file of ["audit.js", "licenses.js", "releases.js", "devices.js", "contacts.js"]) {
    const src = read(`server/src/routes/admin/${file}`);
    assert.match(src, /listPage\(request, \{/, `${file} pages through the shared contract`);
    assert.match(src, /countQuery:/, `${file} reports the exact total`);
    assert.match(src, /pageResponseSchema\(/, `${file} declares the cursor and total, or fastify drops them`);
  }
});

await check("the console shows how far through a list the reader is", () => {
  const pager = read("web/components/pagination.js");
  assert.match(pager, /total\.toLocaleString\(\)/, "the total is shown, not just the page");
  assert.match(pager, /truncatedWithoutNext/, "a list that cannot page further says so");
  for (const page of ["audit", "licenses", "releases", "devices", "contacts"]) {
    const src = read(`web/app/admin/${page}/page.js`);
    assert.match(src, /<Pagination/, `${page} renders the pager`);
    assert.match(src, /cursor=\{cursor\}/, `${page} carries the cursor`);
  }
});

await check("usage answers the shape of the spend, not only its size", async () => {
  const analytics = read("server/src/services/usage-analytics.js");
  for (const needed of [/percentile_disc\(0\.5\)/, /percentile_disc\(0\.9\)/, /percentile_disc\(0\.99\)/, /max\(input_tokens \+ output_tokens\)/]) {
    assert.match(analytics, needed, "the distribution is computed, not approximated");
  }
  assert.match(analytics, /top1DeviceShare/, "concentration is reported");
  assert.match(analytics, /top5DeviceShare/);
  assert.match(analytics, /coverage/, "and so is how much of the window carries token data");
  assert.match(analytics, /perTurnAvailable: false/, "per-turn distribution is declared unavailable rather than faked");
  const panel = read("web/components/usage-analytics-panel.js");
  assert.match(panel, /copy\.coverage/, "the reader sees coverage before the numbers");
  assert.match(panel, /tabular-nums/, "and the figures line up");
});

await check("billing events now record the tokens they already knew", () => {
  const wallet = read("server/src/services/wallet.js");
  assert.match(wallet, /billable_tokens: resourceType === "token" \? billableUnits : 0/, "units are tokens when the resource is tokens");
  assert.match(wallet, /input_tokens: Math\.max\(0, Math\.trunc\(Number\(metadata\?\.inputTokens/, "and the reconcile phase's real split is stored");
  assert.match(wallet, /output_tokens: Math\.max\(0, Math\.trunc\(Number\(metadata\?\.outputTokens/);
});

console.log(`\n${checks} checks passed (admin lists and analytics)`);
