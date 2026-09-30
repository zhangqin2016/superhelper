#!/usr/bin/env node
// A client component renders in the locale the SERVER rendered with.
//
// 2026-09-30: useI18n() with no argument guessed on the server (no document →
// zh) while the browser read lily_locale=en, so every en/ar page whose client
// components translate text failed hydration (React #418) — found by an
// Electron run of the rebuilt enterprise consoles; zh pages matched by luck.
// The fix is structural: the root layout, which already knows the locale on
// the server, provides it; the hook prefers it over the cookie guess.
// [gate: enterprise-closed-loop]
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const hook = read("web/lib/use-i18n.js");
const root = read("web/app/layout.js");
const account = read("web/app/account/layout.js");

assert.match(hook, /export function LocaleProvider\(\{ locale, children \}\)/, "the hook module exports a provider");
assert.match(hook, /const serverLocale = useContext\(LocaleContext\)/, "useI18n reads the server locale");
assert.match(hook, /normalizeLocale\(initialLocale \|\| serverLocale \|\| cookieLocale\(\)\)/, "and prefers it over the cookie guess");
assert.match(root, /const \{ locale, dir \} = await getI18n\(\)/, "the root layout knows the locale on the server");
assert.match(root, /<LocaleProvider locale=\{locale\}>\{children\}<\/LocaleProvider>/, "and provides it to every page");

// The account nav follows the locale (it was hardcoded Chinese).
assert.match(account, /await getLocale\(\)/);
for (const label of ["Organizations", "المؤسسات", "Statement", "الكشف"]) assert.ok(account.includes(label), `account nav has ${label}`);
assert.doesNotMatch(account, /className="ml-auto/, "logical margin so the nav sits right in RTL");

// Dates too: a bare toLocaleString() in a client component formats with the
// container's zone/locale (UTC, en) on the server and the operator's in the
// browser — the admin licence list failed hydration this way (React #418).
// Client components format through lib/admin-time.mjs (explicit zone).
const bare = /\.toLocale(Date|Time)?String\(\s*\)/;
const clientFiles = [];
for (const dir of ["web/components", "web/app"]) {
  for (const entry of fs.readdirSync(new URL(`../${dir}`, import.meta.url), { recursive: true })) {
    if (!/\.(js|jsx|mjs)$/.test(entry)) continue;
    const text = read(`${dir}/${entry}`);
    if (/^\s*["']use client["']/.test(text)) clientFiles.push([`${dir}/${entry}`, text]);
  }
}
assert.ok(clientFiles.length > 10, "the scan found the client components");
for (const [file, text] of clientFiles) assert.doesNotMatch(text, bare, `${file}: bare toLocale*() in a client component breaks hydration`);
const time = await import(new URL("../web/lib/admin-time.mjs", import.meta.url));
assert.equal(time.adminDateTime("2026-09-30T03:05:00Z"), "2026-09-30 11:05", "Beijing time, one shape everywhere");
assert.equal(time.adminDate("2026-09-30T20:00:00Z"), "2026-10-01");
assert.equal(time.adminDate(null), "-");

console.log("web locale hydration: ok");
