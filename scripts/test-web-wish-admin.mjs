#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");

const listPage = read("../web/app/admin/wishes/page.js");
const detailPage = read("../web/app/admin/wishes/[id]/page.js");
const form = read("../web/components/wish-admin-form.js");
const actions = read("../web/app/admin/actions.js");
const shell = read("../web/components/admin-shell.js");
const nav = read("../web/components/admin-nav.js");

assert.match(listPage, /safeApiGet\(`\/api\/admin\/wishes/);
assert.match(detailPage, /api\/admin\/workspace-apps/);
assert.match(detailPage, /api\/admin\/skill-packages/);
assert.match(detailPage, /WishAdminForm/);
assert.match(form, /updateWishAction/);
assert.match(form, /mergeWishAction/);
assert.match(actions, /export async function updateWishAction/);
assert.match(actions, /export async function mergeWishAction/);
assert.match(actions, /apiPatch\(`\/api\/admin\/wishes\/\$\{id\}`/);
assert.match(actions, /apiPost\(`\/api\/admin\/wishes\/\$\{id\}\/merge`/);
assert.match(shell, /href: "\/admin\/wishes"/);
assert.match(nav, /"\/admin\/wishes"/);

const { dictionaries } = await import("../web/lib/i18n.mjs");
for (const locale of ["zh", "en", "ar"]) {
  assert.equal(typeof dictionaries[locale].admin.nav.wishes, "string", `${locale} admin wish nav missing`);
  assert.equal(typeof dictionaries[locale].admin.wishes.title, "string", `${locale} admin wish copy missing`);
  assert.equal(typeof dictionaries[locale].admin.wishes.statuses.shipped, "string", `${locale} shipped label missing`);
}

console.log("web-wish-admin: ok");
