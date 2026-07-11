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
assert.match(page, /publicApiGet\(`\/api\/wishes\$\{query\}`\)/);
assert.match(page, /normalizePublicWishes/);
assert.match(board, /copy\.statuses\[wish\.status\]/);
assert.equal(board.includes("submitter"), false);
assert.equal(board.includes("supportCount"), false);

console.log("web-wish-pool: ok");
