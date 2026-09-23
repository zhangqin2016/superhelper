#!/usr/bin/env node
// Three inconsistencies an operator meets across the console, each previously
// maintained by whoever wrote the page:
//   - an empty list could render as a blank box (the shared table rendered
//     whatever `empty` it was handed, including nothing);
//   - four panels each defined their own form Field, so the same control showed
//     help on one page and not another, and never showed a field-level error;
//   - required fields and url fields were validated only by the server, so the
//     operator learned about a typo after a round trip.
// [gate: admin-consistency]
// Run: node scripts/test-admin-consistency.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

await check("an empty list can never render as a blank box", async () => {
  const table = read("web/components/admin-data-table.js");
  assert.match(table, /\{empty \|\| <AdminEmpty/, "the shared table supplies its own empty state");
  assert.match(table, /t\?\.admin\?\.emptyState\?\.title/, "in the operator's language");
  const empty = read("web/components/admin-empty.js");
  assert.ok(!/No data yet|Connect the API|暂无数据/.test(empty), "the component carries no language of its own");
  const { dictionaries } = await import("../web/lib/i18n.mjs");
  const titles = new Set(["zh", "en", "ar"].map((locale) => dictionaries[locale]?.admin?.emptyState?.title));
  assert.equal(titles.size, 3, "each locale has its own empty-state copy");
  assert.ok(![...titles].some((value) => !value), "and none is missing");
});

await check("one Field component, and it can show help, a required marker and an error", () => {
  const field = read("web/components/admin-field.js");
  for (const needed of [/help \? /, /error \? /, /required \? /, /role="alert"/]) {
    assert.match(field, needed, `the shared field renders ${needed}`);
  }
  const offenders = [];
  for (const file of fs.readdirSync(path.join(ROOT, "web/components"))) {
    if (!file.endsWith(".js") || file === "admin-field.js") continue;
    const src = read(`web/components/${file}`);
    if (/^function (Field|ConfigField)\(/m.test(src)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], `these files still define their own field: ${offenders.join(", ")}`);
});

await check("row actions sit in one place, in one order", () => {
  const rowActions = read("web/components/row-actions.js");
  assert.match(rowActions, /justify-end/, "actions align to the end of the row");
  const tables = read("web/components/admin-tables.js");
  assert.match(tables, /<RowActions>/, "the tables use it");
  assert.ok(!/<div className="flex items-center justify-end gap-2">/.test(tables), "and no hand-rolled copy remains");
});

await check("a form catches what the server would reject, before asking the server", () => {
  const panel = read("web/components/model-providers-panel.js");
  const idInput = panel.slice(panel.indexOf('name="id" required'), panel.indexOf('name="id" required') + 220);
  assert.match(idInput, /minLength=\{2\}/, "the same minimum the server enforces");
  assert.match(idInput, /pattern="\[A-Za-z0-9\._\\-\]\+"/, "and the same shape");
  assert.match(panel, /name="baseUrl" type="url"/, "a base url is validated as a url");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js") && /noValidate/.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, "web"));
  assert.deepEqual(offenders, [], `these forms disable browser validation: ${offenders.join(", ")}`);
});

console.log(`\n${checks} checks passed (admin consistency)`);
