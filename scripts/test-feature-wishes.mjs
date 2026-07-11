#!/usr/bin/env node
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://unused:unused@localhost:5432/unused";

const {
  canTransitionWish,
  findSimilarWishes,
  mergeSupporterIds,
  normalizeWishInput,
  serializePublicWish,
  validateWishPublication,
} = await import("../server/src/services/feature-wishes.js");

const publicRow = {
  id: "wish_invoice",
  submitter_user_id: "usr_private",
  title: "raw private title",
  problem: "private workflow details",
  desired_outcome: "private desired outcome",
  public_title: "自动整理发票",
  public_title_i18n: { en: "Organize invoices automatically" },
  public_summary: "识别、去重并生成报销表。",
  public_summary_i18n: {},
  public_update: "正在验证票据去重。",
  public_update_i18n: {},
  category: "office",
  status: "building",
  linked_app_ids: [],
  linked_skill_ids: [],
  support_count: "4",
  created_at: "2026-07-11T00:00:00.000Z",
  updated_at: "2026-07-11T00:00:00.000Z",
};

assert.deepEqual(serializePublicWish(publicRow, { locale: "en" }), {
  id: "wish_invoice",
  title: "Organize invoices automatically",
  summary: "识别、去重并生成报销表。",
  update: "正在验证票据去重。",
  originalLocale: "zh",
  category: "office",
  status: "building",
  linkedAppIds: [],
  linkedSkillIds: [],
  supportCount: 4,
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
});
assert.equal(JSON.stringify(serializePublicWish(publicRow)).includes("usr_private"), false);
assert.equal(JSON.stringify(serializePublicWish(publicRow)).includes("private workflow"), false);
assert.equal(serializePublicWish({ ...publicRow, status: "pending" }), null);

assert.deepEqual(
  validateWishPublication({ ...publicRow, status: "shipped" }),
  { ok: false, code: "WISH_SHIPPED_LINK_REQUIRED" },
);
assert.deepEqual(
  validateWishPublication({ ...publicRow, status: "shipped", linked_app_ids: ["invoice-app"] }),
  { ok: true },
);

assert.equal(canTransitionWish("pending", "published"), true);
assert.equal(canTransitionWish("reviewing", "declined"), true);
assert.equal(canTransitionWish("declined", "building"), false);
assert.equal(canTransitionWish("merged", "published"), false);

assert.deepEqual(
  mergeSupporterIds(["usr_a", "usr_b"], ["usr_b", "usr_c"]),
  ["usr_a", "usr_b", "usr_c"],
);

const similar = findSimilarWishes("自动整理报销发票", [
  { id: "wish_invoice", public_title: "自动整理发票报销表" },
  { id: "wish_slide", public_title: "研究资料生成演示文稿" },
]);
assert.equal(similar[0].id, "wish_invoice");
assert.equal(similar.some((item) => item.id === "wish_slide"), false);

assert.deepEqual(
  normalizeWishInput({
    title: "  自动整理每月报销发票  ",
    problem: "  发票数量很多，人工检查重复和缺失很慢。  ",
    desiredOutcome: "  生成公司的报销表并标出需要补充的票据。  ",
    category: "office",
  }),
  {
    ok: true,
    value: {
      title: "自动整理每月报销发票",
      problem: "发票数量很多，人工检查重复和缺失很慢。",
      desiredOutcome: "生成公司的报销表并标出需要补充的票据。",
      category: "office",
    },
  },
);
assert.equal(
  normalizeWishInput({ title: " x ", problem: "short", desiredOutcome: "short" }).ok,
  false,
);

console.log("feature-wishes: ok");
