#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

const {
  classifyWishResult,
  normalizePublicWishes,
  wishQuery,
} = await import("../web/lib/public-wishes.mjs");

const wishes = normalizePublicWishes({ wishes: [{
  id: "wish_invoice",
  title: "自动整理发票",
  summary: "识别、去重并生成报销表。",
  update: "正在验证票据去重。",
  originalLocale: "zh",
  category: "office",
  status: "building",
  linkedAppIds: ["invoice-app"],
  linkedSkillIds: [],
  supportCount: 12,
  supportedByViewer: true,
  submitter_user_id: "usr_private",
  problem: "private",
}] });
assert.deepEqual(wishes, [{
  id: "wish_invoice",
  title: "自动整理发票",
  summary: "识别、去重并生成报销表。",
  update: "正在验证票据去重。",
  originalLocale: "zh",
  category: "office",
  status: "building",
  linkedAppIds: ["invoice-app"],
  linkedSkillIds: [],
  supportedByViewer: true,
}]);
assert.equal(JSON.stringify(wishes).includes("usr_private"), false);
assert.equal(JSON.stringify(wishes).includes("supportCount"), false);

assert.equal(wishQuery({ status: "building", category: "office", sort: "recent", locale: "en" }), "?status=building&category=office&sort=recent&locale=en");
assert.equal(wishQuery({ status: "pending", sort: "invalid", locale: "xx" }), "?sort=popular&locale=zh");
assert.deepEqual(classifyWishResult({ ok: false, code: "CATALOG_TIMEOUT" }), { state: "error", wishes: [] });
assert.deepEqual(classifyWishResult({ ok: true, data: { wishes: [] } }), { state: "empty", wishes: [] });
assert.equal(classifyWishResult({ ok: true, data: { wishes } }).state, "ready");

const page = fs.readFileSync(new URL("../web/app/wishes/page.js", import.meta.url), "utf8");
const board = fs.readFileSync(new URL("../web/components/wish-board.js", import.meta.url), "utf8");
assert.match(page, /userApiGetResult\(`\/api\/wishes\$\{query\}`\)/);
assert.match(page, /normalizePublicWishes/);
assert.match(board, /copy\.statuses\[wish\.status\]/);
assert.equal(board.includes("submitter"), false);
assert.equal(board.includes("supportCount"), false);

const supportButton = fs.readFileSync(new URL("../web/components/wish-support-button.js", import.meta.url), "utf8");
const submitForm = fs.readFileSync(new URL("../web/components/wish-submit-form.js", import.meta.url), "utf8");
const actions = fs.readFileSync(new URL("../web/app/wishes/actions.js", import.meta.url), "utf8");
const accountWishes = fs.readFileSync(new URL("../web/app/account/wishes/page.js", import.meta.url), "utf8");
const loginPage = fs.readFileSync(new URL("../web/app/account/login/page.js", import.meta.url), "utf8");
const accountActions = fs.readFileSync(new URL("../web/app/account/actions.js", import.meta.url), "utf8");
assert.match(board, /WishSupportButton/);
assert.match(board, /initialSupported=\{wish\.supportedByViewer\}/);
assert.match(supportButton, /toggleWishSupportAction/);
assert.match(supportButton, /\/account\/login\?next=\/wishes/);
assert.match(submitForm, /sessionStorage/);
assert.match(submitForm, /findSimilarWishesAction/);
assert.match(submitForm, /createWishAction/);
assert.match(submitForm, /function update[\s\S]+setCreated\(false\)/);
assert.match(actions, /userApiPost\("\/api\/wishes\/similar"/);
assert.match(actions, /userApiPost\("\/api\/wishes"/);
assert.match(actions, /userApiDelete\(`\/api\/wishes\/\$\{wishId\}\/support`/);
assert.match(accountWishes, /userApiGet\("\/api\/account\/wishes"/);
assert.match(loginPage, /value === "\/wishes"/);
assert.match(accountActions, /value === "\/wishes"/);

const skillCatalog = fs.readFileSync(new URL("../web/components/skill-catalog.js", import.meta.url), "utf8");
const wishPreview = fs.readFileSync(new URL("../web/components/home/wish-pool-preview.js", import.meta.url), "utf8");
const appDetail = fs.readFileSync(new URL("../web/app/apps/[id]/page.js", import.meta.url), "utf8");
assert.match(skillCatalog, /id=\{skill\.id\}/);
assert.match(wishPreview, /copy\.statuses\[wish\.status\]/);
assert.match(appDetail, /generateMetadata/);
assert.match(appDetail, /`\/apps\/\$\{encodeURIComponent\(id\)\}`/);

console.log("web-wish-pool: ok");
