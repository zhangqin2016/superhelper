#!/usr/bin/env node
// Two console defects an operator meets on their first day: deleting a device
// group or a model provider submitted on the FIRST click while deleting a
// config rule right beside them asked for confirmation, and the navigation rail
// scrolled away with the content (and vanished entirely on a narrow window, so
// every other page became unreachable).
// [gate: admin-destructive-and-chrome]
// Run: node scripts/test-admin-destructive-and-chrome.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

const DESTRUCTIVE = /^(delete|remove|rollback|revoke|purge|wipe|merge)/i;

await check("every destructive action is wired through the one form that confirms", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const src = fs.readFileSync(full, "utf8");
      for (const match of src.matchAll(/<form\s+action=\{(\w+)\}/g)) {
        if (DESTRUCTIVE.test(match[1])) offenders.push(`${path.relative(ROOT, full)}: <form action={${match[1]}}>`);
      }
    }
  };
  walk(path.join(ROOT, "web"));
  assert.deepEqual(offenders, [], `these destructive actions submit without confirmation:\n${offenders.join("\n")}`);
});

await check("the shared form always asks, and names what is about to go", () => {
  const src = fs.readFileSync(path.join(ROOT, "web/components/danger-form.js"), "utf8");
  assert.match(src, /if \(!window\.confirm\(message\)\) event\.preventDefault\(\)/, "no path skips the question");
  assert.match(src, /const message = name \? `\$\{question\}\\n\\n\$\{name\}` : question/, "the target is named in the question");
  assert.match(src, /t\?\.admin\?\.confirmDestructive/, "and it is translated");
  const { dictionaries } = fs.existsSync(path.join(ROOT, "web/lib/i18n.mjs")) ? {} : {};
  assert.ok(!/confirm=\{\s*undefined/.test(src));
});

await check("the destructive confirmation is translated in all three locales", async () => {
  const { dictionaries } = await import("../web/lib/i18n.mjs");
  const texts = new Set();
  for (const locale of ["zh", "en", "ar"]) {
    const copy = dictionaries[locale]?.admin?.confirmDestructive;
    assert.ok(copy, `${locale} has the confirmation`);
    texts.add(copy);
  }
  assert.equal(texts.size, 3, "each locale says it in its own language");
});

await check("the page itself does not scroll: each column scrolls on its own", () => {
  const css = fs.readFileSync(path.join(ROOT, "web/app/globals.css"), "utf8");
  const layout = css.slice(css.indexOf(".admin-layout {"), css.indexOf(".admin-sidebar {"));
  assert.match(layout, /height: 100vh/, "the console is exactly one screen tall");
  assert.match(layout, /overflow: hidden/, "so the document never scrolls and takes the nav with it");
  const rail = css.slice(css.indexOf(".admin-sidebar {"), css.indexOf(".admin-main {"));
  assert.match(rail, /height: 100%/, "the rail fills its column instead of ending mid-page");
  assert.match(rail, /overflow-y: auto/, "and scrolls on its own when it is taller than the screen");
  const main = css.slice(css.indexOf(".admin-main {"));
  assert.match(main, /overflow-y: auto/, "the content column scrolls on its own");
  assert.match(main, /flex-direction: column/, "and its last card can take the height that is left");
  // A long table scrolls inside its card with the header pinned, so the columns
  // stay readable however far down the list the reader is.
  assert.match(main, /\.table-card \.overflow-x-auto,/, "the scroller is the wrapper every table card already has");
  assert.match(main, /position: sticky;\n  top: 0;/, "the header stays visible");
  const narrow = css.slice(css.indexOf(".admin-layout { grid-template-columns: 1fr; }"));
  assert.ok(!/\.admin-sidebar \{ display: none; \}/.test(narrow), "a narrow window still has navigation");
  assert.match(narrow, /max-height: 220px/, "as a short scrollable strip");
});

await check("rows are dense enough that a screen shows a screenful", () => {
  const table = fs.readFileSync(path.join(ROOT, "web/components/ui/table.js"), "utf8");
  assert.match(table, /px-4 py-2 font-medium/, "header cells are compact");
  assert.match(table, /px-4 py-2 align-middle/, "and so are body cells");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.js" && /className="px-5 py-4/.test(fs.readFileSync(full, "utf8"))) {
        offenders.push(path.relative(ROOT, full));
      }
    }
  };
  walk(path.join(ROOT, "web/app/admin"));
  assert.deepEqual(offenders, [], `these tables still use the old row height: ${offenders.join(", ")}`);
});

console.log(`\n${checks} checks passed (admin destructive actions and chrome)`);
