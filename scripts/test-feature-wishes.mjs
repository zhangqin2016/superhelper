#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DATABASE_URL ||= "postgres://unused:unused@localhost:5432/unused";

const {
  canTransitionWish,
  createWishActionLimiter,
  findSimilarWishes,
  mergeSupporterIds,
  normalizeWishInput,
  serializePublicWish,
  validateWishPublication,
} = await import("../server/src/services/feature-wishes.js");
const { classifyWebSession } = await import("../server/src/services/web-user-session.js");

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

const migration = fs.readFileSync(
  new URL("../server/migrations/023_feature_wishes.sql", import.meta.url),
  "utf8",
);
assert.match(migration, /create table if not exists feature_wishes/i);
assert.match(migration, /create table if not exists feature_wish_supporters/i);
assert.match(migration, /unique\s*\(wish_id,\s*user_id\)/i);
assert.match(migration, /merged_into_id text references feature_wishes\(id\) on delete set null/i);
assert.match(migration, /wish_id text not null references feature_wishes\(id\) on delete cascade/i);
assert.match(migration, /check \(status in \('pending','reviewing','published','planned','building','shipped','declined','merged'\)\)/i);
assert.match(migration, /feature_wishes_public_idx/i);
assert.match(migration, /feature_wishes_submitter_idx/i);

const validVerified = { ok: true, userId: "usr_1", sessionId: "sess_1" };
const validSession = {
  id: "sess_1",
  user_id: "usr_1",
  revoked_at: null,
  expires_at: "2026-07-12T00:00:00.000Z",
};
const now = new Date("2026-07-11T00:00:00.000Z").getTime();
assert.deepEqual(classifyWebSession({ verified: { ok: false, code: "INVALID" }, session: null, now }), {
  ok: false,
  code: "USER_LOGIN_REQUIRED",
});
assert.deepEqual(classifyWebSession({ verified: validVerified, session: validSession, now }), {
  ok: true,
  userId: "usr_1",
  sessionId: "sess_1",
});
assert.equal(classifyWebSession({ verified: validVerified, session: { ...validSession, user_id: "usr_2" }, now }).ok, false);
assert.equal(classifyWebSession({ verified: validVerified, session: { ...validSession, revoked_at: new Date() }, now }).ok, false);
assert.equal(
  classifyWebSession({
    verified: validVerified,
    session: { ...validSession, expires_at: "2026-07-10T00:00:00.000Z" },
    now,
  }).ok,
  false,
);

let limiterNow = 1_000;
const limiter = createWishActionLimiter({ now: () => limiterNow });
for (let index = 0; index < 5; index += 1) {
  assert.equal(limiter.take("usr_1", "create"), true);
}
assert.equal(limiter.take("usr_1", "create"), false);
assert.equal(limiter.take("usr_2", "create"), true);
limiterNow += 60 * 60 * 1000;
assert.equal(limiter.take("usr_1", "create"), true);
assert.equal(limiter.take("usr_1", "unknown"), false);

const publicWishRouteSource = fs.readFileSync(
  new URL("../server/src/routes/public/wishes.js", import.meta.url),
  "utf8",
);
for (const route of [
  "/api/wishes",
  "/api/wishes/:id",
  "/api/wishes/similar",
  "/api/wishes/:id/support",
  "/api/account/wishes",
]) {
  assert.equal(publicWishRouteSource.includes(route), true, `missing public wish route ${route}`);
}
assert.match(publicWishRouteSource, /requireWebUser/);
assert.match(publicWishRouteSource, /serializePublicWish/);
assert.match(publicWishRouteSource, /createWishActionLimiter/);
assert.match(publicWishRouteSource, /onConflict[\s\S]+columns\(\["wish_id",\s*"user_id"\]\)/);

const publicRoutesSource = fs.readFileSync(new URL("../server/src/routes/public.js", import.meta.url), "utf8");
assert.match(publicRoutesSource, /registerPublicWishRoutes\(app\)/);

const openapiSource = fs.readFileSync(new URL("../server/src/openapi.js", import.meta.url), "utf8");
assert.match(openapiSource, /public:wishes/);

console.log("feature-wishes: ok");
